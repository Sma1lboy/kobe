import { describe, expect, it } from "vitest"

import { spacedTitle, truncateTitle } from "../../src/tui/panes/sidebar/labels"

describe("sidebar row labels", () => {
  it("keeps the glyph-to-title spacer inside the label", () => {
    expect(spacedTitle("kobe", 12)).toBe(" kobe")
  })

  it("preserves the spacer when the title is ellipsised", () => {
    expect(spacedTitle("delta_project", 6)).toBe(" delta…")
  })

  it("does not bake spacing into plain title truncation", () => {
    expect(truncateTitle("delta_project", 6)).toBe("delta…")
  })
})
