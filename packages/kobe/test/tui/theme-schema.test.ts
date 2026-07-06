/**
 * Unit tests for the theme schema validator.
 *
 * The validator backs two paths users can hit if they author broken
 * JSON: the disk loader (`loader.ts`, called at boot for files under
 * `~/.kobe/themes/`) and the CLI (`kobe theme add` for fetched URLs).
 * If either silently accepts garbage we end up with `RGBA.fromHex`
 * throwing inside the render loop, which would crash kobe at the
 * worst possible moment. These tests pin the contract:
 *
 *   - bare-hex strings, def-name refs, and `{dark,light}` variants are
 *     all valid theme values (the canonical bundled `claude.json`
 *     uses all three forms),
 *   - missing `theme` key, half-formed variants, and non-strings are
 *     rejected with a one-line reason suitable for `console.warn`.
 */

import { describe, expect, test } from "vitest"
import { isHex, validateTheme } from "../../src/tui/context/theme/schema"

describe("isHex", () => {
  test("accepts 3, 6, and 8 digit hex", () => {
    expect(isHex("#abc")).toBe(true)
    expect(isHex("#ABCDEF")).toBe(true)
    expect(isHex("#aabbccdd")).toBe(true)
  })
  test("rejects malformed strings", () => {
    expect(isHex("abc")).toBe(false)
    expect(isHex("#abcd")).toBe(false) // 4 digits
    expect(isHex("#abcdefg")).toBe(false) // non-hex char
    expect(isHex("")).toBe(false)
  })
})

describe("validateTheme — accepts", () => {
  test("a minimal theme with hex values only", () => {
    const r = validateTheme({ theme: { background: "#000000", text: "#ffffff" } })
    expect(r.ok).toBe(true)
  })

  test("def references in theme values (bare strings that aren't hex)", () => {
    const r = validateTheme({
      defs: { brand: "#cc785c" },
      theme: { primary: "brand" },
    })
    expect(r.ok).toBe(true)
  })

  test("dark/light variant values", () => {
    const r = validateTheme({
      theme: {
        background: { dark: "#101010", light: "#fafafa" },
        text: "#abcdef",
      },
    })
    expect(r.ok).toBe(true)
  })

  test("missing defs key (it is optional)", () => {
    const r = validateTheme({ theme: { text: "#fff" } })
    expect(r.ok).toBe(true)
  })

  test("optional $schema string", () => {
    const r = validateTheme({ $schema: "https://example.com/theme.json", theme: { text: "#fff" } })
    expect(r.ok).toBe(true)
  })
})

describe("validateTheme — rejects", () => {
  test("missing required `theme` key", () => {
    const r = validateTheme({ defs: { x: "#000" } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/theme/)
  })

  test("variant with only `dark` and no `light`", () => {
    const r = validateTheme({ theme: { background: { dark: "#000" } } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/light/)
  })

  test("non-string in a theme value (number)", () => {
    const r = validateTheme({ theme: { background: 0xffffff } })
    expect(r.ok).toBe(false)
  })

  test("non-object input", () => {
    expect(validateTheme("not an object").ok).toBe(false)
    expect(validateTheme(42).ok).toBe(false)
    expect(validateTheme([]).ok).toBe(false)
  })

  test("null input", () => {
    expect(validateTheme(null).ok).toBe(false)
  })

  test("non-string in defs", () => {
    const r = validateTheme({ defs: { x: 123 }, theme: { text: "#fff" } })
    expect(r.ok).toBe(false)
  })

  test("`theme` is not an object", () => {
    const r = validateTheme({ theme: "claude" })
    expect(r.ok).toBe(false)
  })
})
