/**
 * Framework-free theme core, shared by the Solid provider (`./theme.tsx`)
 * and the React one (`src/tui-react/context/theme.tsx`). Extracted during
 * the React migration (issue #15, G2): JSON shape types, hex/def-ref/variant
 * resolution, and the display-time overlay (focus-accent slot +
 * transparent-background policy) all live here so the two providers cannot
 * drift. The bundled theme JSONs themselves live in `./theme/bundled`.
 */

import { RGBA } from "@opentui/core"

import { BUNDLED_THEME_JSONS } from "./theme/bundled"

type HexColor = `#${string}`
type RefName = string
type Variant = { dark: HexColor | RefName; light: HexColor | RefName }
type ColorValue = HexColor | RefName | Variant

export type ThemeJson = {
  $schema?: string
  defs?: Record<string, HexColor | RefName>
  theme: Record<string, ColorValue>
}

/**
 * The set of color slots kobe components expect to find on a `Theme`. The
 * names mirror opencode's so lifted components keep compiling. Entries marked
 * optional fall back to a related slot when missing.
 */
export type Theme = {
  primary: RGBA
  secondary: RGBA
  accent: RGBA
  error: RGBA
  warning: RGBA
  success: RGBA
  info: RGBA
  text: RGBA
  textMuted: RGBA
  background: RGBA
  backgroundPanel: RGBA
  backgroundElement: RGBA
  backgroundMenu: RGBA
  /**
   * Modal/dialog card surface. In transparent mode this keeps the same
   * RGB as the active theme but becomes semi-transparent so the host
   * terminal can show through the card.
   * Falls back to `backgroundPanel` at theme-resolution time.
   */
  backgroundDialog: RGBA
  border: RGBA
  borderActive: RGBA
  borderSubtle: RGBA
  diffAdded: RGBA
  diffRemoved: RGBA
  diffContext: RGBA
  diffHunkHeader: RGBA
  diffAddedBg: RGBA
  diffRemovedBg: RGBA
  selectedListItemText: RGBA
  /**
   * Resolved focus-indicator color. Components that paint focus state
   * read this instead of picking primary/success/info directly, so the
   * user-controlled `focusAccent` setting unifies the focus signal.
   */
  focusAccent: RGBA
  // arbitrary string access falls through to text
  [key: string]: RGBA
}

/**
 * The bundled theme registry. The JSON payloads live in `./theme/bundled`
 * (the single owner); this re-export keeps the historical import path for
 * consumers (`src/tui-react/context/theme.tsx`, tests).
 */
export const BUNDLED_THEMES: Record<string, ThemeJson> = BUNDLED_THEME_JSONS

/**
 * Is `name` a known theme? Framework-free check against the bundled set —
 * the live provider (`src/tui-react/context/theme.tsx`) keeps its own
 * mutable registry for user-added themes; this bundled-only check is what
 * off-render callers (e.g. `readPersistedUiPrefs` in a pane subprocess)
 * use to validate a persisted theme name before applying it.
 */
export function hasTheme(name: string): boolean {
  return Boolean(BUNDLED_THEMES[name])
}

/**
 * Which theme slot drives the "focused pane" indicator. Default is
 * `primary` — under the Claude palette that's terracotta, which doubles
 * as the brand hue. `success` keeps the older green-focus look
 * (opencode legacy); `info` picks the cyan/blue. Persisted via KV.
 */
export type FocusAccentSlot = "primary" | "success" | "info"
export const FOCUS_ACCENT_SLOTS: ReadonlyArray<FocusAccentSlot> = ["primary", "success", "info"]

/**
 * Resolve a theme JSON to flat RGBA values. Missing slots fall back to
 * `text` for foregrounds and `background` for backgrounds; this means we
 * never throw if a freshly-copied opencode theme is missing one of the
 * extended slots opencode added later.
 */
export function resolveTheme(theme: ThemeJson, mode: "dark" | "light" = "dark"): Theme {
  const defs = theme.defs ?? {}

  function resolve(c: ColorValue, chain: string[] = []): RGBA {
    if (typeof c === "string") {
      if (c === "transparent" || c === "none") return RGBA.fromInts(0, 0, 0, 0)
      if (c.startsWith("#")) return RGBA.fromHex(c)
      if (chain.includes(c)) {
        // circular ref — collapse to black rather than throw to keep the TUI alive
        return RGBA.fromInts(0, 0, 0)
      }
      const next = defs[c] ?? (theme.theme[c] as ColorValue | undefined)
      if (next === undefined) return RGBA.fromInts(0, 0, 0)
      return resolve(next, [...chain, c])
    }
    return resolve(c[mode], chain)
  }

  const out: Record<string, RGBA> = {}
  for (const [k, v] of Object.entries(theme.theme)) {
    out[k] = resolve(v as ColorValue)
  }

  // Fallback chain: ensure the slots kobe components consume are defined.
  const text = out.text ?? RGBA.fromHex("#ffffff")
  const background = out.background ?? RGBA.fromHex("#000000")
  const fallback: Record<string, RGBA> = {
    primary: out.primary ?? text,
    secondary: out.secondary ?? text,
    accent: out.accent ?? out.primary ?? text,
    error: out.error ?? text,
    warning: out.warning ?? text,
    success: out.success ?? text,
    info: out.info ?? text,
    text,
    textMuted: out.textMuted ?? text,
    background,
    backgroundPanel: out.backgroundPanel ?? background,
    backgroundElement: out.backgroundElement ?? background,
    backgroundMenu: out.backgroundMenu ?? out.backgroundElement ?? background,
    backgroundDialog: out.backgroundDialog ?? out.backgroundPanel ?? background,
    border: out.border ?? text,
    borderActive: out.borderActive ?? out.border ?? text,
    borderSubtle: out.borderSubtle ?? out.border ?? text,
    diffAdded: out.diffAdded ?? out.success ?? text,
    diffRemoved: out.diffRemoved ?? out.error ?? text,
    diffContext: out.diffContext ?? out.textMuted ?? text,
    diffHunkHeader: out.diffHunkHeader ?? out.textMuted ?? text,
    diffAddedBg: out.diffAddedBg ?? background,
    diffRemovedBg: out.diffRemovedBg ?? background,
    selectedListItemText: out.selectedListItemText ?? background,
  }

  return { ...fallback, ...out } as Theme
}

/**
 * Display-time overlay on a resolved palette:
 *
 *   1. `focusAccent` is derived from the user-picked slot (primary /
 *      success / info), falling back to `primary` if a user-installed
 *      theme is missing the chosen slot.
 *   2. When `transparentBackground` is on, BOTH `background` AND
 *      `backgroundPanel` are forced to alpha-0 — panels (sidebar, right
 *      column, chat tab strip) all read panel, and the policy is "in
 *      transparent mode, get out of the way of the host terminal". Only
 *      `backgroundElement` keeps its tinted value so the chat input stays
 *      legible against any host wallpaper. `backgroundDialog` deliberately
 *      stays OPAQUE: a translucent modal card lets pane content bleed
 *      through the dialog text. Transparency is for the chrome around
 *      content, never for an overlay you must read.
 */
export function applyDisplayOverlay(base: Theme, focusAccent: FocusAccentSlot, transparentBackground: boolean): Theme {
  const v: Theme = { ...base, focusAccent: base[focusAccent] ?? base.primary }
  if (!transparentBackground) return v
  const transparent = RGBA.fromInts(0, 0, 0, 0)
  return {
    ...v,
    background: transparent,
    backgroundPanel: transparent,
  }
}
