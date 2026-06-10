/**
 * Theme-matched tmux pane borders.
 *
 * kobe's opentui panes are fully themed, but the 1-cell separator lines
 * BETWEEN panes are drawn by tmux with its stock style — terminal-default
 * foreground for `pane-border-style`, `fg=green` for the active border.
 * Under dark themes the stock line blends into the pane background and
 * the workspace loses its visible pane boundaries (and the only focus
 * cue tmux offers). This module derives the two border styles from the
 * active kobe theme and injects them as server-global options on the
 * `-L kobe` socket:
 *
 *   pane-border-style        fg=<theme.border>
 *   pane-active-border-style fg=<theme.focusAccent slot>   (focus signal,
 *                            same slot the in-pane focus indicators use)
 *
 * PRECEDENCE: kobe owns these two options on its own socket. The `-L
 * kobe` socket loads the user's `~/.tmux.conf`, but that config was
 * written for their own tmux — popular setups (e.g. oh-my-tmux's
 * `#303030` border) are exactly what makes the kobe workspace borders
 * invisible, so yielding to it would leave the bug in place for the
 * people who hit it. Forcing the option on kobe's socket is the same
 * stance the server-nicety block already takes for `mouse on` and
 * `status-right`; the user's real tmux server is never touched. The
 * escape hatch is `"tmuxBorderTheme": "off"` in `state.json`, which
 * releases the options back to whatever the server would otherwise
 * have (tmux stock until the user's conf reloads on the next server).
 *
 * The `@kobe_border_theme` marker records which options kobe wrote so
 * the off-switch (or a theme slot resolving to null) unsets only what
 * kobe set and never clobbers an option it never owned. Pure planning
 * is split from IO so the rules are unit-tested without a tmux server.
 */

import { readFileSync } from "node:fs"
import { kvStatePath } from "../../env"
import { runTmuxCapturing, runTmuxSequence } from "../../tmux/client"
import type { ThemeJson } from "../context/theme"
import { BUNDLED_THEME_JSONS } from "../context/theme/bundled"
import { resolveThemeSlotHex } from "../context/theme/hex"
import { loadUserThemes } from "../context/theme/loader"

/** Server-global user option recording which border options kobe wrote. */
export const BORDER_THEME_MARKER_OPTION = "@kobe_border_theme"

/**
 * Mirror of `FOCUS_ACCENT_SLOTS` in `theme.tsx` — not imported because
 * that module builds a Solid store at load time and this one must stay
 * importable from CLI/session-build code.
 */
const FOCUS_ACCENT_SLOT_NAMES = ["primary", "success", "info"] as const

interface BorderPrefs {
  readonly themeName: string
  readonly focusAccentSlot: string
  /** `"tmuxBorderTheme": "off"` in state.json disables the injection. */
  readonly enabled: boolean
}

/**
 * Raw read of the KV keys this module needs. Deliberately NOT
 * `readPersistedUiPrefs` — that helper validates the theme name against
 * the Solid theme registry (`hasTheme`), which would pull the TUI
 * runtime into every `ensureSession` caller.
 */
function readBorderPrefs(): BorderPrefs {
  try {
    const parsed = JSON.parse(readFileSync(kvStatePath(), "utf8")) as Record<string, unknown>
    const themeName = typeof parsed.activeTheme === "string" && parsed.activeTheme ? parsed.activeTheme : "claude"
    const focusAccentSlot =
      typeof parsed.focusAccent === "string" &&
      (FOCUS_ACCENT_SLOT_NAMES as readonly string[]).includes(parsed.focusAccent)
        ? parsed.focusAccent
        : "primary"
    return { themeName, focusAccentSlot, enabled: parsed.tmuxBorderTheme !== "off" }
  } catch {
    return { themeName: "claude", focusAccentSlot: "primary", enabled: true }
  }
}

/** User themes shadow bundled ones — same precedence as the boot loader. */
function lookupThemeJson(name: string): ThemeJson | null {
  const user = loadUserThemes().find((t) => t.name === name)
  return user?.theme ?? BUNDLED_THEME_JSONS[name] ?? null
}

/**
 * The two border colors for a theme. Fallback chains mirror
 * `resolveTheme()`: `border` falls back to `text`; the active border
 * uses the user's focus-accent slot with the same `primary` fallback
 * the in-pane focus indicators apply.
 */
export function resolveBorderHexes(
  theme: ThemeJson,
  focusAccentSlot: string,
): { border: string | null; active: string | null } {
  const border = resolveThemeSlotHex(theme, "border") ?? resolveThemeSlotHex(theme, "text")
  const active =
    resolveThemeSlotHex(theme, focusAccentSlot) ??
    resolveThemeSlotHex(theme, "primary") ??
    resolveThemeSlotHex(theme, "borderActive") ??
    border
  return { border, active }
}

export interface BorderThemePlanInput {
  /** Current `@kobe_border_theme` value, `""` when unset. */
  readonly marker: string
  /** Current global `pane-border-style` value, `""` when unreadable. */
  readonly currentBorder: string
  /** Current global `pane-active-border-style` value, `""` when unreadable. */
  readonly currentActive: string
  readonly borderHex: string | null
  readonly activeHex: string | null
}

/**
 * Decide which set-option commands to run. Pure — all tmux reads happen
 * before, all writes after. A non-null hex claims the option (rewriting
 * whatever is there, kobe's socket = kobe's borders); a `null` hex
 * (disabled, or a theme slot that resolves to nothing) releases the
 * option via `-u` — but only when the marker says kobe wrote it, so we
 * never unset a value we never owned.
 */
export function planBorderTheme(input: BorderThemePlanInput): string[][] {
  const owned = new Set(
    input.marker
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  const commands: string[][] = []
  const nextOwned: string[] = []

  const options = [
    { key: "border", option: "pane-border-style", current: input.currentBorder, hex: input.borderHex },
    { key: "active", option: "pane-active-border-style", current: input.currentActive, hex: input.activeHex },
  ] as const

  for (const o of options) {
    if (o.hex) {
      const style = `fg=${o.hex}`
      if (o.current !== style) commands.push(["set-option", "-gw", o.option, style])
      nextOwned.push(o.key)
    } else if (owned.has(o.key)) {
      commands.push(["set-option", "-gwu", o.option])
    }
  }

  const nextMarker = nextOwned.join(",")
  if (nextMarker !== input.marker) {
    commands.push(
      nextMarker
        ? ["set-option", "-g", BORDER_THEME_MARKER_OPTION, nextMarker]
        : ["set-option", "-gu", BORDER_THEME_MARKER_OPTION],
    )
  }
  return commands
}

async function readOption(args: string[]): Promise<string> {
  const { code, stdout } = await runTmuxCapturing(args)
  return code === 0 ? stdout.trim() : ""
}

/**
 * Resolve the active theme's border colors and apply them to the kobe
 * tmux server. Best-effort and idempotent: no server / no theme / a
 * user-styled border all reduce to a no-op, and failures never block
 * the caller (launch, settings exit).
 */
export async function applyTmuxPaneBorderTheme(): Promise<void> {
  try {
    const prefs = readBorderPrefs()
    const themeJson = prefs.enabled ? lookupThemeJson(prefs.themeName) : null
    // Disabled or unknown theme → null hexes, which release (never set)
    // the options below; a marker-less server then plans zero commands.
    const { border, active } = themeJson
      ? resolveBorderHexes(themeJson, prefs.focusAccentSlot)
      : { border: null, active: null }
    // `-q` keeps an unset option (notably the marker on a fresh server)
    // from logging an "invalid option" error line through runTmuxCapturing.
    const [currentBorder, currentActive, marker] = await Promise.all([
      readOption(["show-options", "-gwqv", "pane-border-style"]),
      readOption(["show-options", "-gwqv", "pane-active-border-style"]),
      readOption(["show-options", "-gqv", BORDER_THEME_MARKER_OPTION]),
    ])
    const commands = planBorderTheme({ marker, currentBorder, currentActive, borderHex: border, activeHex: active })
    if (commands.length > 0) await runTmuxSequence(commands)
  } catch {
    // cosmetic — never surface to the launch / settings flows
  }
}
