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
      const fallback = store.themes.claude ?? store.themes.opencode ?? Object.values(store.themes)[0]
      if (!fallback) {
        return resolveTheme({ theme: { background: "#000000", text: "#ffffff" } }, store.mode)
      }
      return resolveTheme(fallback, store.mode)
    })
    const values = createMemo(() => applyDisplayOverlay(baseValues(), store.focusAccent, store.transparentBackground))

    createEffect(() => {
      renderer?.setBackgroundColor(values().background)
    })

    return {
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
