/**
 * Theme-matched tmux chrome.
 *
 * kobe's opentui panes are fully themed, but the 1-cell separator lines
 * BETWEEN panes and the bottom status/window bar are drawn by tmux with
 * its stock styles — terminal-default foreground for `pane-border-style`,
 * `fg=green` for the active border, and `bg=green,fg=black` for
 * `status-style`. Under dark themes those defaults clash with kobe's
 * panes and make the workspace read as two unrelated UIs. This module
 * derives the tmux-owned chrome from the active kobe theme and injects
 * it as global options on the `-L kobe` socket:
 *
 *   pane-border-style        fg=<theme.borderSubtle>, or <theme.border>
 *                            when transparent mode needs more separation
 *   pane-active-border-style fg=<theme.focusAccent slot>   (focus signal,
 *                            same slot the in-pane focus indicators use)
 *   status-style             bg=<theme.backgroundPanel> fg=<theme.textMuted>
 *   window-status-*          inactive / current / activity / bell styles
 *   status-left/right-style  bg=<status bg> fg=<theme.textMuted>
 *   message/mode/display-*   tmux prompts, copy-mode, pane-picker overlays
 *
 * PRECEDENCE: kobe owns these options on its own socket. The `-L
 * kobe` socket loads the user's `~/.tmux.conf`, but that config was
 * written for their own tmux — popular setups (e.g. oh-my-tmux's
 * `#303030` border and tmux's stock green status bar) are exactly what
 * makes the kobe workspace look unthemed, so yielding to it would leave
 * the bug in place for the people who hit it. Forcing the option on kobe's
 * socket is the same
 * stance the server-nicety block already takes for `mouse on` and
 * `status-right`; the user's real tmux server is never touched. The
 * escape hatch is `"tmuxChromeTheme": "off"` in `state.json` (or the
 * legacy `"tmuxBorderTheme": "off"`), which
 * releases the options back to whatever the server would otherwise
 * have (tmux stock until the user's conf reloads on the next server).
 *
 * The legacy `@kobe_border_theme` marker records which options kobe wrote so
 * the off-switch (or a theme slot resolving to null) unsets only what
 * kobe set and never clobbers an option it never owned. Pure planning
 * is split from IO so the rules are unit-tested without a tmux server.
 */

import { readFileSync } from "node:fs"
import { kvStatePath } from "../../env"
import { runTmuxCapturing, runTmuxSequence } from "../../tmux/client"
import type { ThemeJson } from "../context/theme-core"
import { BUNDLED_THEME_JSONS } from "../context/theme/bundled"
import { resolveThemeSlotHex } from "../context/theme/hex"
import { loadUserThemes } from "../context/theme/loader"

/**
 * Server-global user option recording which tmux chrome options kobe wrote.
 * The old name is intentionally kept so upgrades can release/extend options
 * claimed by the previous pane-border-only implementation.
 */
export const TMUX_CHROME_THEME_MARKER_OPTION = "@kobe_border_theme"

/** Back-compat alias for older tests/callers. */
export const BORDER_THEME_MARKER_OPTION = TMUX_CHROME_THEME_MARKER_OPTION

/**
 * Mirror of `FOCUS_ACCENT_SLOTS` in `theme.tsx` — not imported because
 * that module builds a Solid store at load time and this one must stay
 * importable from CLI/session-build code.
 */
const FOCUS_ACCENT_SLOT_NAMES = ["primary", "success", "info"] as const

interface TmuxChromePrefs {
  readonly themeName: string
  readonly focusAccentSlot: string
  readonly transparentBackground: boolean
  /** `"tmuxChromeTheme": "off"` in state.json disables the injection. */
  readonly enabled: boolean
}

/**
 * Raw read of the KV keys this module needs. Deliberately NOT
 * `readPersistedUiPrefs` — that helper validates the theme name against
 * the Solid theme registry (`hasTheme`), which would pull the TUI
 * runtime into every `ensureSession` caller.
 */
function readTmuxChromePrefs(): TmuxChromePrefs {
  try {
    const parsed = JSON.parse(readFileSync(kvStatePath(), "utf8")) as Record<string, unknown>
    const themeName = typeof parsed.activeTheme === "string" && parsed.activeTheme ? parsed.activeTheme : "claude"
    const focusAccentSlot =
      typeof parsed.focusAccent === "string" &&
      (FOCUS_ACCENT_SLOT_NAMES as readonly string[]).includes(parsed.focusAccent)
        ? parsed.focusAccent
        : "primary"
    return {
      themeName,
      focusAccentSlot,
      transparentBackground: parsed.transparentBackground === true,
      enabled: parsed.tmuxChromeTheme !== "off" && parsed.tmuxBorderTheme !== "off",
    }
  } catch {
    return { themeName: "claude", focusAccentSlot: "primary", transparentBackground: false, enabled: true }
  }
}

/** User themes shadow bundled ones — same precedence as the boot loader. */
function lookupThemeJson(name: string): ThemeJson | null {
  const user = loadUserThemes().find((t) => t.name === name)
  return user?.theme ?? BUNDLED_THEME_JSONS[name] ?? null
}

/**
 * The two border colors for a theme. Inactive pane edges use the subtle
 * divider on solid backgrounds, but the regular border in transparent mode
 * where there is no panel fill to separate adjacent regions. The active edge
 * keeps the user's focus-accent slot.
 */
export function resolveBorderHexes(
  theme: ThemeJson,
  focusAccentSlot: string,
  transparentBackground = false,
): { border: string | null; active: string | null } {
  const hexes = resolveTmuxChromeHexes(theme, focusAccentSlot, transparentBackground)
  const border = hexes.border
  const active = hexes.activeBorder
  return { border, active }
}

export interface TmuxChromeHexes {
  readonly border: string | null
  readonly activeBorder: string | null
  readonly statusBg: string | null
  readonly statusFg: string | null
  readonly statusMutedFg: string | null
  readonly windowFg: string | null
  readonly currentWindowBg: string | null
  readonly currentWindowFg: string | null
  readonly activityFg: string | null
  readonly bellFg: string | null
  readonly messageBg: string | null
  readonly messageFg: string | null
  readonly messageCommandFg: string | null
  readonly modeBg: string | null
  readonly modeFg: string | null
}

function firstHex(theme: ThemeJson, ...slots: string[]): string | null {
  for (const slot of slots) {
    const hex = resolveThemeSlotHex(theme, slot)
    if (hex) return hex
  }
  return null
}

/**
 * All colors needed for tmux-owned chrome. The fallback chains mirror
 * `resolveTheme()` where possible, but return null when a whole category
 * cannot be derived so the planner releases instead of painting black.
 */
export function resolveTmuxChromeHexes(
  theme: ThemeJson,
  focusAccentSlot: string,
  transparentBackground = false,
): TmuxChromeHexes {
  const text = firstHex(theme, "text")
  const background = firstHex(theme, "background")
  const textMuted = firstHex(theme, "textMuted", "text")
  const backgroundPanel = firstHex(theme, "backgroundPanel", "background")
  const backgroundElement = firstHex(theme, "backgroundElement", "backgroundPanel", "background")
  const backgroundMenu = firstHex(theme, "backgroundMenu", "backgroundElement", "backgroundPanel", "background")
  const selectedListItemText = firstHex(theme, "selectedListItemText", "background")
  const primary = firstHex(theme, focusAccentSlot, "primary", "borderActive", "border", "text")

  return {
    border: transparentBackground
      ? firstHex(theme, "border", "borderSubtle", "text")
      : firstHex(theme, "borderSubtle", "border", "text"),
    activeBorder: primary,
    statusBg: backgroundPanel,
    statusFg: textMuted,
    statusMutedFg: textMuted,
    windowFg: textMuted,
    currentWindowBg: backgroundElement,
    currentWindowFg: primary,
    activityFg: firstHex(theme, "info", "primary", "text"),
    bellFg: firstHex(theme, "warning", "error", "primary", "text"),
    messageBg: backgroundMenu,
    messageFg: text,
    messageCommandFg: primary,
    modeBg: primary,
    modeFg: selectedListItemText ?? background,
  }
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

export type TmuxChromeOptionKey =
  | "border"
  | "active"
  | "status"
  | "status-left"
  | "status-right"
  | "window"
  | "current-window"
  | "activity-window"
  | "bell-window"
  | "last-window"
  | "message"
  | "message-command"
  | "mode"
  | "display-panes"
  | "display-panes-active"

interface TmuxChromeOptionValue {
  readonly key: TmuxChromeOptionKey
  readonly option: string
  readonly showFlag: "-gqv" | "-gwqv"
  readonly setFlag: "-g" | "-gw"
  readonly unsetFlag: "-gu" | "-gwu"
  readonly value: string | null
}

function style(parts: { bg?: string | null; fg?: string | null; attrs?: readonly string[] }): string | null {
  const chunks: string[] = []
  if (parts.bg) chunks.push(`bg=${parts.bg}`)
  if (parts.fg) chunks.push(`fg=${parts.fg}`)
  if (chunks.length === 0) return null
  if (parts.attrs) chunks.push(...parts.attrs)
  return chunks.join(",")
}

function tmuxChromeOptionValues(hexes: TmuxChromeHexes): TmuxChromeOptionValue[] {
  const statusStyle = style({ bg: hexes.statusBg, fg: hexes.statusFg })
  const statusMutedStyle = style({ bg: hexes.statusBg, fg: hexes.statusMutedFg })
  const windowStyle = style({ bg: hexes.statusBg, fg: hexes.windowFg })
  return [
    {
      key: "border",
      option: "pane-border-style",
      showFlag: "-gwqv",
      setFlag: "-gw",
      unsetFlag: "-gwu",
      value: style({ fg: hexes.border }),
    },
    {
      key: "active",
      option: "pane-active-border-style",
      showFlag: "-gwqv",
      setFlag: "-gw",
      unsetFlag: "-gwu",
      value: style({ fg: hexes.activeBorder }),
    },
    {
      key: "status",
      option: "status-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: statusStyle,
    },
    {
      key: "status-left",
      option: "status-left-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: statusMutedStyle,
    },
    {
      key: "status-right",
      option: "status-right-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: statusMutedStyle,
    },
    {
      key: "window",
      option: "window-status-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: windowStyle,
    },
    {
      key: "current-window",
      option: "window-status-current-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: style({ bg: hexes.currentWindowBg, fg: hexes.currentWindowFg, attrs: ["bold"] }),
    },
    {
      key: "activity-window",
      option: "window-status-activity-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: style({ bg: hexes.statusBg, fg: hexes.activityFg }),
    },
    {
      key: "bell-window",
      option: "window-status-bell-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: style({ bg: hexes.statusBg, fg: hexes.bellFg, attrs: ["bold"] }),
    },
    {
      key: "last-window",
      option: "window-status-last-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: style({ bg: hexes.statusBg, fg: hexes.statusFg }),
    },
    {
      key: "message",
      option: "message-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: style({ bg: hexes.messageBg, fg: hexes.messageFg }),
    },
    {
      key: "message-command",
      option: "message-command-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: style({ bg: hexes.messageBg, fg: hexes.messageCommandFg, attrs: ["bold"] }),
    },
    {
      key: "mode",
      option: "mode-style",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: style({ bg: hexes.modeBg, fg: hexes.modeFg }),
    },
    {
      key: "display-panes",
      option: "display-panes-colour",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: hexes.border,
    },
    {
      key: "display-panes-active",
      option: "display-panes-active-colour",
      showFlag: "-gqv",
      setFlag: "-g",
      unsetFlag: "-gu",
      value: hexes.activeBorder,
    },
  ]
}

export interface TmuxChromeThemePlanInput {
  readonly marker: string
  readonly current: Partial<Record<TmuxChromeOptionKey, string>>
  readonly hexes: TmuxChromeHexes
}

/** Plan theme writes for pane borders, status/window bar, prompts, copy-mode, and pane-picker overlays. */
export function planTmuxChromeTheme(input: TmuxChromeThemePlanInput): string[][] {
  const owned = new Set(
    input.marker
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  const commands: string[][] = []
  const nextOwned: string[] = []

  for (const item of tmuxChromeOptionValues(input.hexes)) {
    if (item.value) {
      if ((input.current[item.key] ?? "") !== item.value) {
        commands.push(["set-option", item.setFlag, item.option, item.value])
      }
      nextOwned.push(item.key)
    } else if (owned.has(item.key)) {
      commands.push(["set-option", item.unsetFlag, item.option])
    }
  }

  const nextMarker = nextOwned.join(",")
  if (nextMarker !== input.marker) {
    commands.push(
      nextMarker
        ? ["set-option", "-g", TMUX_CHROME_THEME_MARKER_OPTION, nextMarker]
        : ["set-option", "-gu", TMUX_CHROME_THEME_MARKER_OPTION],
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
  await applyTmuxChromeTheme()
}

/**
 * Resolve the active theme's tmux chrome colors and apply them to the kobe
 * tmux server. Best-effort and idempotent: no server / no theme / disabled
 * theme injection all reduce to a no-op or a release, and failures never
 * block the caller (launch, settings exit).
 */
export async function applyTmuxChromeTheme(): Promise<void> {
  try {
    const prefs = readTmuxChromePrefs()
    const themeJson = prefs.enabled ? lookupThemeJson(prefs.themeName) : null
    // Disabled or unknown theme → null hexes, which release (never set)
    // the options below; a marker-less server then plans zero commands.
    const hexes = themeJson
      ? resolveTmuxChromeHexes(themeJson, prefs.focusAccentSlot, prefs.transparentBackground)
      : resolveTmuxChromeHexes({ theme: {} }, prefs.focusAccentSlot)
    // `-q` keeps an unset option (notably the marker on a fresh server)
    // from logging an "invalid option" error line through runTmuxCapturing.
    const options = tmuxChromeOptionValues(hexes)
    const [marker, ...values] = await Promise.all([
      readOption(["show-options", "-gqv", TMUX_CHROME_THEME_MARKER_OPTION]),
      ...options.map((item) => readOption(["show-options", item.showFlag, item.option])),
    ])
    const current = Object.fromEntries(options.map((item, i) => [item.key, values[i] ?? ""]))
    const commands = planTmuxChromeTheme({ marker, current, hexes })
    if (commands.length > 0) await runTmuxSequence(commands)
  } catch {
    // cosmetic — never surface to the launch / settings flows
  }
}
