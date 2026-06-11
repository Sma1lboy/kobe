import { describe, expect, it } from "vitest"
import { themeCommandEntries } from "../src/lib/palette-commands.ts"

/**
 * themeCommandEntries feeds the command palette's "Theme: <name>" entries. The
 * label is what fuzzy search matches (so typing "theme" or a theme name finds
 * them), the id is stable per theme, and the active theme is flagged so the
 * palette can mark it.
 */

describe("themeCommandEntries", () => {
  it("returns one entry per theme with a stable id and a 'Theme: ' label", () => {
    const out = themeCommandEntries(["claude", "tokyonight"], null)
    expect(out).toEqual([
      { id: "theme:claude", label: "Theme: claude", hint: "theme", name: "claude" },
      {
        id: "theme:tokyonight",
        label: "Theme: tokyonight",
        hint: "theme",
        name: "tokyonight",
      },
    ])
  })

  it("flags the active theme with the 'active' hint", () => {
    const out = themeCommandEntries(["claude", "tokyonight"], "tokyonight")
    expect(out.find((e) => e.name === "tokyonight")?.hint).toBe("active")
    expect(out.find((e) => e.name === "claude")?.hint).toBe("theme")
  })

  it("returns an empty list before themes have loaded", () => {
    expect(themeCommandEntries([], null)).toEqual([])
  })

  it("carries the name through for setPreferredTheme to apply", () => {
    expect(themeCommandEntries(["claude"], null)[0].name).toBe("claude")
  })
})
