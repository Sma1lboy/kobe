import { describe, expect, it } from "vitest"
import { resolveEffectiveTheme } from "../src/lib/theme.ts"

/**
 * Theme precedence: a web-local override (Settings picker) wins over the TUI's
 * pushed theme (ui-prefs), which wins over the fallback. This is the rule the
 * Settings "Follow TUI" affordance depends on.
 */

describe("resolveEffectiveTheme", () => {
  it("prefers the web-local override over everything", () => {
    expect(resolveEffectiveTheme("dracula", "tokyonight", "claude")).toBe("dracula")
  })

  it("falls back to the TUI prefs when there's no override", () => {
    expect(resolveEffectiveTheme(null, "tokyonight", "claude")).toBe("tokyonight")
  })

  it("falls back to the default when neither is set", () => {
    expect(resolveEffectiveTheme(null, null, "claude")).toBe("claude")
  })

  it("defaults to claude when no fallback is given", () => {
    expect(resolveEffectiveTheme(null, null)).toBe("claude")
  })

  it("an override of the same name as prefs is still the override", () => {
    expect(resolveEffectiveTheme("nord", "nord", "claude")).toBe("nord")
  })
})
