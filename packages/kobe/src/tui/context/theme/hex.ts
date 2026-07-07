/**
 * Pure hex resolver for theme JSON slots — the opentui-free sibling of
 * `resolveTheme()` in `theme.tsx`.
 *
 * `resolveTheme` returns `@opentui/core` RGBA values and lives in a module
 * that builds a Solid store at import time, so CLI / session-build code
 * (e.g. tmux styling) can't import it without dragging in the whole TUI
 * runtime — the same constraint that keeps `cli/theme.ts` away from
 * `theme.tsx`. This module resolves a single slot to a plain `#rrggbb`
 * string instead, mirroring `resolve()`'s semantics (defs refs, slot
 * refs, `{dark,light}` variants, circular-ref protection) with one
 * deliberate difference: unresolvable / circular / transparent values
 * return `null` rather than collapsing to black — for tmux styling,
 * "skip the option" beats "paint it black".
 */

import type { ThemeJson } from "../theme-core"

type Variant = { dark: string; light: string }
type ColorValue = string | Variant

/**
 * Normalize a theme hex literal to the 6-digit `#rrggbb` form tmux
 * accepts: expand `#abc`, strip the alpha byte off `#rrggbbaa`, and
 * lowercase. Returns `null` for malformed values.
 */
export function normalizeHex(value: string): string | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value)
  if (!m) return null
  const digits = m[1] as string
  if (digits.length === 3) {
    const [r, g, b] = digits
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return `#${digits.slice(0, 6)}`.toLowerCase()
}

/**
 * Resolve one theme slot to a `#rrggbb` hex string, following defs refs
 * and slot refs exactly like `resolveTheme()`. Returns `null` when the
 * slot is missing, transparent, circular, or malformed.
 */
export function resolveThemeSlotHex(theme: ThemeJson, slot: string, mode: "dark" | "light" = "dark"): string | null {
  const defs = theme.defs ?? {}

  function resolve(c: ColorValue, chain: string[]): string | null {
    if (typeof c === "string") {
      if (c === "transparent" || c === "none") return null
      if (c.startsWith("#")) return normalizeHex(c)
      if (chain.includes(c)) return null
      const next = (defs[c] ?? theme.theme[c]) as ColorValue | undefined
      if (next === undefined) return null
      return resolve(next, [...chain, c])
    }
    if (!c || typeof c !== "object") return null
    const variant = c[mode]
    return typeof variant === "string" ? resolve(variant, chain) : null
  }

  const value = theme.theme[slot] as ColorValue | undefined
  if (value === undefined) return null
  return resolve(value, [slot])
}
