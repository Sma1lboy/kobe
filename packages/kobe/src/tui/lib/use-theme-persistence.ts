/**
 * Theme / KV round-trip — extracted from `Shell` in `app.tsx`.
 *
 * `ThemeProvider` is mounted OUTER of `KVProvider`, so it can't hydrate
 * its initial value from KV on mount. Instead we run a one-shot hydrate
 * inside the Shell when both contexts are available, then register
 * three `createEffect`s that mirror every subsequent change back to KV:
 *
 *   - `activeTheme` (validated against the registry to drop stale names)
 *   - `transparentBackground` (boolean)
 *   - `focusAccent` (validated against `FOCUS_ACCENT_SLOTS`)
 *
 * Same hydrate-then-mirror pattern across all three round-trips. The
 * hook owns all of them so Shell only has to call it once.
 *
 * Must be invoked inside a Solid component scope (the `createEffect`s
 * are part of the surrounding owner's lifecycle).
 */

import { createEffect } from "solid-js"
import { FOCUS_ACCENT_SLOTS, type FocusAccentSlot, type ThemeContext } from "../context/theme"
import type { KVContext } from "../context/kv"

export function useThemePersistence(themeCtx: ThemeContext, kv: KVContext): void {
  // Theme persistence — on mount, hydrate from KV (validates the
  // stored name against the bundled list to drop stale entries from a
  // theme that was renamed). Same shape for the orthogonal
  // `transparentBackground` toggle. `ThemeProvider` is mounted OUTER
  // of `KVProvider`, so we hydrate here rather than inside the
  // provider's init.
  const persistedTheme = kv.get("activeTheme")
  if (typeof persistedTheme === "string" && themeCtx.has(persistedTheme)) {
    themeCtx.set(persistedTheme)
  }
  const persistedTransparent = kv.get("transparentBackground")
  if (typeof persistedTransparent === "boolean") {
    themeCtx.setTransparentBackground(persistedTransparent)
  }
  // Focus-accent slot — same hydrate-then-mirror pattern. Validates
  // against the known slot list so a stale value from an older kobe
  // (or a hand-edited state.json) drops cleanly to default rather than
  // poisoning the proxy.
  const persistedFocusAccent = kv.get("focusAccent")
  if (
    typeof persistedFocusAccent === "string" &&
    (FOCUS_ACCENT_SLOTS as ReadonlyArray<string>).includes(persistedFocusAccent)
  ) {
    themeCtx.setFocusAccent(persistedFocusAccent as FocusAccentSlot)
  }
  createEffect(() => {
    kv.set("activeTheme", themeCtx.selected)
  })
  createEffect(() => {
    kv.set("transparentBackground", themeCtx.transparentBackground)
  })
  createEffect(() => {
    kv.set("focusAccent", themeCtx.focusAccent)
  })
}
