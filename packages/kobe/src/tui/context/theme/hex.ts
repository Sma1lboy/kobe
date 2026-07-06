import type { ThemeJson } from "../theme"

type Variant = { dark: string; light: string }
type ColorValue = string | Variant

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
