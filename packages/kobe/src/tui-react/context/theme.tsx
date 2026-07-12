/** @jsxImportSource @opentui/react */
/**
 * Theme provider for kobe (React) — the `src/tui/context/theme.tsx`
 * counterpart for React panes (issue #15, G2). All theme SEMANTICS
 * (bundled registry, resolution, focus-accent + transparent overlay) come
 * from the shared framework-free `src/tui/context/theme-core.ts`; this file
 * owns only the React reactivity.
 *
 * Differences from the Solid provider, by design:
 *   - `useTheme().theme` is a PLAIN resolved object, not a Proxy. React
 *     components re-render via context when the theme changes, so
 *     per-property reactive reads have no equivalent — and a plain object
 *     keeps `theme.background` call sites source-compatible.
 *   - Module-level registry state lives in an external store (subscribed
 *     via useSyncExternalStore), matching the Solid module-store semantics:
 *     `addTheme`/`listThemes` work before or outside any provider.
 */

import { RGBA } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { type ReactNode, createContext, useContext, useEffect, useMemo } from "react"
import { createExternalStore } from "../../lib/external-store"
import {
  BUNDLED_THEMES,
  type FocusAccentSlot,
  type Theme,
  type ThemeJson,
  applyDisplayOverlay,
  resolveTheme,
} from "../../tui/context/theme-core"
import { useAccessor } from "../lib/use-accessor"

export { FOCUS_ACCENT_SLOTS, resolveTheme } from "../../tui/context/theme-core"
export type { FocusAccentSlot, Theme, ThemeJson } from "../../tui/context/theme-core"

type State = {
  readonly themes: Record<string, ThemeJson>
  readonly active: string
  readonly mode: "dark" | "light"
  readonly transparentBackground: boolean
  readonly focusAccent: FocusAccentSlot
  readonly reducedMotion: boolean
}

const store = createExternalStore<State>({
  themes: { ...BUNDLED_THEMES },
  active: "claude",
  mode: "dark",
  // Transparent by default (2026-07-12) — kobe sits on the terminal's own
  // background unless the user explicitly turns transparency off.
  transparentBackground: true,
  focusAccent: "primary",
  reducedMotion: false,
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

// Module-level accessors/setters, mirroring the Solid module's
// store-outside-the-provider semantics. The React host-boot path (issue #15
// G3) seeds persisted prefs through these BEFORE the first render (no
// flash) and applies live daemon ui-prefs pushes without a hook scope; the
// provider's context methods delegate to the same store.

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

export function reducedMotion(): boolean {
  return store.get().reducedMotion
}

export function setReducedMotion(v: boolean): void {
  store.update((s) => ({ ...s, reducedMotion: v }))
}

export function setThemeMode(mode: "dark" | "light"): void {
  store.update((s) => ({ ...s, mode }))
}

export type ThemeContextValue = {
  /** The resolved palette. Plain object — re-renders arrive via context. */
  theme: Theme
  selected: string
  transparentBackground: boolean
  focusAccent: FocusAccentSlot
  reducedMotion: boolean
  mode(): "dark" | "light"
  set(name: string): boolean
  setMode(mode: "dark" | "light"): void
  setTransparentBackground(v: boolean): void
  setFocusAccent(v: FocusAccentSlot): void
  setReducedMotion(v: boolean): void
  all(): string[]
  has(name: string): boolean
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function resolveActive(state: State): Theme {
  const active = state.themes[state.active]
  if (active) return resolveTheme(active, state.mode)
  // safety net: if active was somehow cleared, fall back to claude
  const fallback = state.themes.claude ?? state.themes.opencode ?? Object.values(state.themes)[0]
  if (!fallback) {
    // truly empty — synthesize a black theme so the renderer can stand up
    return resolveTheme({ theme: { background: "#000000", text: "#ffffff" } }, state.mode)
  }
  return resolveTheme(fallback, state.mode)
}

export function ThemeProvider(props: { children?: ReactNode; mode?: "dark" | "light"; theme?: string }) {
  // Seed once from props, mirroring the Solid provider's init block. Done
  // during the first render (not an effect) so the very first paint already
  // uses the requested theme; the store dedupes identical snapshots.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed-once semantics, matching Solid's init.
  useMemo(() => {
    store.update((s) => ({
      ...s,
      mode: props.mode ?? s.mode,
      active: props.theme && s.themes[props.theme] ? props.theme : s.active,
    }))
  }, [])

  const state = useAccessor(store)
  const renderer = useRenderer()

  const theme = useMemo(
    () => applyDisplayOverlay(resolveActive(state), state.focusAccent, state.transparentBackground),
    [state],
  )

  // Push background to the renderer so the terminal background matches
  // (or shows through, when transparentBackground is on). Inline hosts
  // (split-footer: update list, onboarding) never paint one — a CLI
  // command should sit on the shell's own background, prompt-style.
  useEffect(() => {
    if (renderer?.screenMode === "split-footer") return
    renderer?.setBackgroundColor(theme.background ?? RGBA.fromInts(0, 0, 0))
  }, [renderer, theme])

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      selected: state.active,
      transparentBackground: state.transparentBackground,
      focusAccent: state.focusAccent,
      reducedMotion: state.reducedMotion,
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
      setReducedMotion(v: boolean): void {
        store.update((s) => ({ ...s, reducedMotion: v }))
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
