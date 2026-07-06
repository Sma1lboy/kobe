/**
 * Why this matters: `applyDisplayOverlay` encodes two policies both
 * frameworks must share exactly — the user-picked focus-accent slot (with
 * primary fallback for themes missing the slot) and transparent mode's
 * "chrome goes alpha-0, dialog card stays opaque" rule (see
 * memory/feedback_transparent_default_aggressive.md). The overlay was
 * extracted from the Solid provider during G2; this pins the extraction
 * didn't change behavior and the React provider inherits the same rules.
 */

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
    // The composer body tint survives so input stays legible…
    expect(out.backgroundElement).toBe(base.backgroundElement)
    // …and the dialog card stays opaque so overlays stay readable.
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
