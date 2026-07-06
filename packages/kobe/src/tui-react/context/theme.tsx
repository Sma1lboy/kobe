/** @jsxImportSource @opentui/react */

import { RGBA } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { type ReactNode, createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react"
import { createExternalStore } from "../../lib/external-store"
import {
  BUNDLED_THEMES,
  type FocusAccentSlot,
  type Theme,
  type ThemeJson,
  applyDisplayOverlay,
  resolveTheme,
} from "../../tui/context/theme-core"

export { FOCUS_ACCENT_SLOTS, resolveTheme } from "../../tui/context/theme-core"
export type { FocusAccentSlot, Theme, ThemeJson } from "../../tui/context/theme-core"

type State = {
  readonly themes: Record<string, ThemeJson>
  readonly active: string
  readonly mode: "dark" | "light"
  readonly transparentBackground: boolean
  readonly focusAccent: FocusAccentSlot
}

const store = createExternalStore<State>({
  themes: { ...BUNDLED_THEMES },
  active: "claude",
  mode: "dark",
  transparentBackground: false,
  focusAccent: "primary",
})

export function listThemes(): string[] {
  return Object.keys(store.get().themes)
}

export function hasTheme(name: string): boolean {
  return Boolean(store.get().themes[name])
}

export function addTheme(name: string, theme: ThemeJson): boolean {
  if (!name) return false
  if (!theme || typeof theme !== "object" || !theme.theme) return false
  store.update((s) => ({ ...s, themes: { ...s.themes, [name]: theme } }))
  return true
}

export function selectedTheme(): string {
  return store.get().active
}

export function setTheme(name: string): boolean {
  if (!hasTheme(name)) return false
  store.update((s) => ({ ...s, active: name }))
  return true
}

export function transparentBackground(): boolean {
  return store.get().transparentBackground
}

export function setTransparentBackground(v: boolean): void {
  store.update((s) => ({ ...s, transparentBackground: v }))
}

export function focusAccent(): FocusAccentSlot {
  return store.get().focusAccent
}

export function setFocusAccent(v: FocusAccentSlot): void {
  store.update((s) => ({ ...s, focusAccent: v }))
}

export function setThemeMode(mode: "dark" | "light"): void {
  store.update((s) => ({ ...s, mode }))
}

export type ThemeContextValue = {
  theme: Theme
  selected: string
  transparentBackground: boolean
  focusAccent: FocusAccentSlot
  mode(): "dark" | "light"
  set(name: string): boolean
  setMode(mode: "dark" | "light"): void
  setTransparentBackground(v: boolean): void
  setFocusAccent(v: FocusAccentSlot): void
  all(): string[]
  has(name: string): boolean
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function resolveActive(state: State): Theme {
  const active = state.themes[state.active]
  if (active) return resolveTheme(active, state.mode)
  const fallback = state.themes.claude ?? state.themes.opencode ?? Object.values(state.themes)[0]
  if (!fallback) {
    return resolveTheme({ theme: { background: "#000000", text: "#ffffff" } }, state.mode)
  }
  return resolveTheme(fallback, state.mode)
}

export function ThemeProvider(props: { children?: ReactNode; mode?: "dark" | "light"; theme?: string }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed-once semantics, matching Solid's init.
  useMemo(() => {
    store.update((s) => ({
      ...s,
      mode: props.mode ?? s.mode,
      active: props.theme && s.themes[props.theme] ? props.theme : s.active,
    }))
  }, [])

  const state = useSyncExternalStore(store.subscribe, store.get, store.get)
  const renderer = useRenderer()

  const theme = useMemo(
    () => applyDisplayOverlay(resolveActive(state), state.focusAccent, state.transparentBackground),
    [state],
  )

  useEffect(() => {
    renderer?.setBackgroundColor(theme.background ?? RGBA.fromInts(0, 0, 0))
  }, [renderer, theme])

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      selected: state.active,
      transparentBackground: state.transparentBackground,
      focusAccent: state.focusAccent,
      mode: () => state.mode,
      set(name: string): boolean {
        if (!hasTheme(name)) return false
        store.update((s) => ({ ...s, active: name }))
        return true
      },
      setMode(mode: "dark" | "light"): void {
        store.update((s) => ({ ...s, mode }))
      },
      setTransparentBackground(v: boolean): void {
        store.update((s) => ({ ...s, transparentBackground: v }))
      },
      setFocusAccent(v: FocusAccentSlot): void {
        store.update((s) => ({ ...s, focusAccent: v }))
      },
      all: listThemes,
      has: hasTheme,
    }),
    [theme, state],
  )

  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error("Theme context must be used within a context provider")
  return value
}
