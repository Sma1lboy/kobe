/**
 * Theme provider for kobe (Solid).
 *
 * Heavily simplified port of opencode's `context/theme.tsx`. The
 * framework-free core — JSON shape, bundled registry, resolution, and the
 * display overlay (focus accent + transparent background policy) — lives in
 * `./theme-core.ts`, shared with the React provider
 * (`src/tui-react/context/theme.tsx`, issue #15 G2). This file owns only the
 * Solid reactivity: the module-level store, the `theme` Proxy (reads inside
 * tracked scopes re-run on change), and the renderer background effect.
 */

import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import {
  BUNDLED_THEMES,
  type FocusAccentSlot,
  type Theme,
  type ThemeJson,
  applyDisplayOverlay,
  resolveTheme,
} from "./theme-core"

export { FOCUS_ACCENT_SLOTS, resolveTheme } from "./theme-core"
export type { FocusAccentSlot, Theme, ThemeJson } from "./theme-core"

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
    // Focus accent + transparent-bg policy live in theme-core so the React
    // provider applies the identical overlay. See applyDisplayOverlay docs
    // and memory/feedback_transparent_default_aggressive.md.
    const values = createMemo(() => applyDisplayOverlay(baseValues(), store.focusAccent, store.transparentBackground))

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
