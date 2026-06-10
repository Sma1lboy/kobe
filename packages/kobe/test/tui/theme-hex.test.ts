import { describe, expect, test } from "vitest"
import type { ThemeJson } from "../../src/tui/context/theme"
import { BUNDLED_THEME_JSONS } from "../../src/tui/context/theme/bundled"
import { normalizeHex, resolveThemeSlotHex } from "../../src/tui/context/theme/hex"

describe("normalizeHex", () => {
  test("passes 6-digit hex through lowercased", () => {
    expect(normalizeHex("#AaBbCc")).toBe("#aabbcc")
  })

  test("expands 3-digit hex", () => {
    expect(normalizeHex("#abc")).toBe("#aabbcc")
  })

  test("strips the alpha byte off 8-digit hex (tmux has no alpha)", () => {
    expect(normalizeHex("#aabbccdd")).toBe("#aabbcc")
  })

  test("rejects malformed values", () => {
    expect(normalizeHex("#ab")).toBeNull()
    expect(normalizeHex("red")).toBeNull()
    expect(normalizeHex("#gggggg")).toBeNull()
  })
})

describe("resolveThemeSlotHex", () => {
  const theme: ThemeJson = {
    defs: { steel: "#445566", alias: "steel" },
    theme: {
      border: "steel",
      borderActive: "alias",
      primary: { dark: "#FF0000", light: "#00ff00" },
      ghost: "transparent",
      loopA: "loopB",
      loopB: "loopA",
      dangling: "noSuchDef",
      viaSlot: "border",
    },
  }

  test("resolves a direct hex slot", () => {
    expect(resolveThemeSlotHex({ theme: { border: "#abc" } }, "border")).toBe("#aabbcc")
  })

  test("follows defs refs, including chained ones", () => {
    expect(resolveThemeSlotHex(theme, "border")).toBe("#445566")
    expect(resolveThemeSlotHex(theme, "borderActive")).toBe("#445566")
  })

  test("follows slot-to-slot refs", () => {
    expect(resolveThemeSlotHex(theme, "viaSlot")).toBe("#445566")
  })

  test("picks the requested variant", () => {
    expect(resolveThemeSlotHex(theme, "primary")).toBe("#ff0000")
    expect(resolveThemeSlotHex(theme, "primary", "light")).toBe("#00ff00")
  })

  test("returns null for transparent, circular, dangling, and missing slots", () => {
    expect(resolveThemeSlotHex(theme, "ghost")).toBeNull()
    expect(resolveThemeSlotHex(theme, "loopA")).toBeNull()
    expect(resolveThemeSlotHex(theme, "dangling")).toBeNull()
    expect(resolveThemeSlotHex(theme, "missing")).toBeNull()
  })

  test("every bundled theme resolves the slots the border styling needs", () => {
    for (const [name, json] of Object.entries(BUNDLED_THEME_JSONS)) {
      const border = resolveThemeSlotHex(json, "border") ?? resolveThemeSlotHex(json, "text")
      const primary = resolveThemeSlotHex(json, "primary")
      expect(border, `${name} border`).toMatch(/^#[0-9a-f]{6}$/)
      expect(primary, `${name} primary`).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})
