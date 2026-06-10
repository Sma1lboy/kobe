/**
 * Theme provider for kobe.
 *
 * Heavily simplified port of opencode's `context/theme.tsx`. We keep the JSON
 * shape (`defs` block + `theme.<name>.{dark|light}` color references) so the
 * theme files copied from opencode work unchanged; we drop the system theme
 * detection, plugin theme registration, syntax-highlight tables, and KV-backed
 * persistence — those stages all assume opencode's runtime, and we'll wire
 * persistence properly in a later stream.
 *
 * What's covered:
 *   - hex / def-ref / variant resolution (`#abc`, `nord3`, `{dark,light}`)
 *   - dark/light mode (defaults to dark; reactive setter)
 *   - exposes `theme` as a Proxy so consumers can read `theme.background`
 *     directly without re-extracting on every render
 *   - register additional themes at runtime via `addTheme`
 *
 * If a theme key is missing on a particular theme, we fall through to the
 * `kobe` default fallback theme — no crash, no `_hasSelectedListItemText`
 * bookkeeping like opencode (we also don't ship `selectedListItemText` as a
 * computed contrast color; for kobe, themes opt in or get `background`).
 */

import { RGBA } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"

import claude from "./theme/claude.json" with { type: "json" }
import conductor from "./theme/conductor.json" with { type: "json" }
import dracula from "./theme/dracula.json" with { type: "json" }
import nord from "./theme/nord.json" with { type: "json" }
import opencode from "./theme/opencode.json" with { type: "json" }
import osakaJade from "./theme/osaka-jade.json" with { type: "json" }
import tokyonight from "./theme/tokyonight.json" with { type: "json" }

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
   * (PaneHeader, Sidebar header, ResizableEdge focused-adjacent,
   * Terminal border) read this instead of picking primary/success/info
   * directly, so the user-controlled `focusAccent` setting unifies the
   * focus signal across panes.
   */
  focusAccent: RGBA
  // arbitrary string access falls through to text
  [key: string]: RGBA
}

const BUNDLED_THEMES: Record<string, ThemeJson> = {
  // Claude-branded palette (terracotta accent on warm neutrals), ported
  // from ashwingopalsamy/claude-code-theme's brandTokens. Default for
  // new kobe installs so the TUI reads as part of the Claude ecosystem.
  claude: claude as ThemeJson,
  conductor: conductor as ThemeJson,
  nord: nord as ThemeJson,
  opencode: opencode as ThemeJson,
  dracula: dracula as ThemeJson,
  tokyonight: tokyonight as ThemeJson,
  "osaka-jade": osakaJade as ThemeJson,
}

/**
 * Which theme slot drives the "focused pane" indicator (pane header
 * title + ▌ marker, sidebar header, resizable-edge, terminal border).
 * Default is `primary` — under the Claude palette that's terracotta,
 * which doubles as the brand hue. `success` keeps the older
 * green-focus look (opencode legacy); `info` picks the cyan/blue.
 * Persisted via KV from the Shell.
 */
export type FocusAccentSlot = "primary" | "success" | "info"
export const FOCUS_ACCENT_SLOTS: ReadonlyArray<FocusAccentSlot> = ["primary", "success", "info"]

type State = {
  themes: Record<string, ThemeJson>
  active: string
  mode: "dark" | "light"
  /**
   * Orthogonal toggle: when true, the resolved theme's `background`
   * slot is forced to RGBA(0,0,0,0). Every other token (panel,
   * element, text, primary, accent…) keeps the active theme's value,
   * so the user pairs any palette with a transparent terminal bg.
   * Persisted via KV from the Shell on mount + every change.
   */
  transparentBackground: boolean
  focusAccent: FocusAccentSlot
}

const [store, setStore] = createStore<State>({
  themes: { ...BUNDLED_THEMES },
  active: "claude",
  mode: "dark",
  transparentBackground: false,
  focusAccent: "primary",
})

export function listThemes(): string[] {
  return Object.keys(store.themes)
}

export function hasTheme(name: string): boolean {
  return Boolean(store.themes[name])
}

export function addTheme(name: string, theme: ThemeJson): boolean {
  if (!name) return false
  if (!theme || typeof theme !== "object" || !theme.theme) return false
  setStore("themes", { ...store.themes, [name]: theme })
  return true
}

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

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: (props: { mode?: "dark" | "light"; theme?: string }) => {
    if (props.mode) setStore("mode", props.mode)
    if (props.theme && hasTheme(props.theme)) setStore("active", props.theme)

    const renderer = useRenderer()
    const baseValues = createMemo(() => {
      const active = store.themes[store.active]
      if (active) return resolveTheme(active, store.mode)
      // safety net: if active was somehow cleared, fall back to claude
      const fallback = store.themes.claude ?? store.themes.opencode ?? Object.values(store.themes)[0]
      if (!fallback) {
        // truly empty — synthesize a black theme so the renderer can stand up
        return resolveTheme({ theme: { background: "#000000", text: "#ffffff" } }, store.mode)
      }
      return resolveTheme(fallback, store.mode)
    })
    // Apply the transparent-bg toggle on top of the resolved palette.
    // BOTH `background` AND `backgroundPanel` are forced transparent
    // — panels (sidebar, right column, chat tab strip) all read panel,
    // and Jackson's policy is "in transparent mode, get out of the
    // way of the host terminal". Only `backgroundElement` (used by
    // the composer body, slash dropdown, inactive tab fills) keeps
    // its tinted value so the chat input stays legible against any
    // host wallpaper. Every other token (text, primary, accent…)
    // is unchanged. See memory/feedback_transparent_default_aggressive.md.
    const values = createMemo(() => {
      const base = baseValues()
      // focusAccent is derived per-frame from the user-picked slot
      // (primary / success / info). Falls back to primary if the
      // resolved theme is missing the chosen slot — defensive against
      // a user-installed theme that doesn't define `info`.
      const focusAccent = base[store.focusAccent] ?? base.primary
      const v: Theme = { ...base, focusAccent }
      if (!store.transparentBackground) return v
      const transparent = RGBA.fromInts(0, 0, 0, 0)
      // `backgroundDialog` deliberately stays OPAQUE: a translucent modal
      // card lets the pane content bleed through the dialog text, which
      // makes settings/help/confirm dialogs unreadable. Transparency is
      // for the chrome around content, never for an overlay you must read.
      return {
        ...v,
        background: transparent,
        backgroundPanel: transparent,
      }
    })

    // Push background to the renderer so the terminal background matches
    // (or shows through, when transparentBackground is on).
    createEffect(() => {
      renderer?.setBackgroundColor(values().background)
    })

    return {
      // proxy mirrors opencode's API: `theme.background` always reads the
      // current resolved color even though `values` is reactive
      theme: new Proxy({} as Theme, {
        get(_t, prop) {
          const cur = values()
          // @ts-expect-error - dynamic indexing
          return cur[prop] ?? cur.text
        },
      }),
      get selected() {
        return store.active
      },
      get transparentBackground() {
        return store.transparentBackground
      },
      get focusAccent() {
        return store.focusAccent
      },
      mode() {
        return store.mode
      },
      set(name: string): boolean {
        if (!hasTheme(name)) return false
        setStore("active", name)
        return true
      },
      setMode(mode: "dark" | "light"): void {
        setStore("mode", mode)
      },
      setTransparentBackground(v: boolean): void {
        setStore("transparentBackground", v)
      },
      setFocusAccent(v: FocusAccentSlot): void {
        setStore("focusAccent", v)
      },
      all(): string[] {
        return listThemes()
      },
      has(name: string): boolean {
        return hasTheme(name)
      },
    }
  },
})
