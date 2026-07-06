import { describe, expect, it } from "vitest"
import { BUNDLED_THEMES, applyDisplayOverlay, resolveTheme } from "../../src/tui/context/theme-core"

const base = resolveTheme(BUNDLED_THEMES.claude as never, "dark")

describe("applyDisplayOverlay", () => {
  it("derives focusAccent from the chosen slot", () => {
    expect(applyDisplayOverlay(base, "success", false).focusAccent).toBe(base.success)
    expect(applyDisplayOverlay(base, "info", false).focusAccent).toBe(base.info)
    expect(applyDisplayOverlay(base, "primary", false).focusAccent).toBe(base.primary)
  })

  it("leaves every other slot untouched when transparent is off", () => {
    const out = applyDisplayOverlay(base, "primary", false)
    expect(out.background).toBe(base.background)
    expect(out.backgroundPanel).toBe(base.backgroundPanel)
    expect(out.backgroundElement).toBe(base.backgroundElement)
    expect(out.text).toBe(base.text)
  })

  it("transparent mode zeroes background AND backgroundPanel only", () => {
    const out = applyDisplayOverlay(base, "primary", true)
    expect(out.background.a).toBe(0)
    expect(out.backgroundPanel.a).toBe(0)
    expect(out.backgroundElement).toBe(base.backgroundElement)
    expect(out.backgroundDialog).toBe(base.backgroundDialog)
  })

  it("resolveTheme output feeds the overlay for every bundled theme without throwing", () => {
    for (const [name, json] of Object.entries(BUNDLED_THEMES)) {
      const resolved = resolveTheme(json, "dark")
      const overlaid = applyDisplayOverlay(resolved, "info", true)
      expect(overlaid.focusAccent, name).toBeDefined()
    }
  })
})
