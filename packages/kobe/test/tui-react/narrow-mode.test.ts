import { describe, expect, it } from "vitest"
import { NARROW_BREAKPOINT, isNarrowWidth, narrowSurface } from "../../src/tui-react/lib/narrow-mode"

describe("isNarrowWidth", () => {
  it("is exclusive at the breakpoint: 70 cols keeps the desktop layout", () => {
    expect(isNarrowWidth(NARROW_BREAKPOINT)).toBe(false)
    expect(isNarrowWidth(NARROW_BREAKPOINT - 1)).toBe(true)
  })

  it("covers the phone-SSH target and common desktop widths", () => {
    expect(isNarrowWidth(46)).toBe(true)
    expect(isNarrowWidth(80)).toBe(false)
  })
})

describe("narrowSurface", () => {
  it("sidebar focus always shows the list — ctrl+q's back gesture", () => {
    expect(narrowSurface({ focusedPane: "sidebar", hasSelection: true, hasOpenPage: false })).toBe("sidebar")
    expect(narrowSurface({ focusedPane: "sidebar", hasSelection: true, hasOpenPage: true })).toBe("sidebar")
  })

  it("entering a task shows the workspace full-screen", () => {
    expect(narrowSurface({ focusedPane: "workspace", hasSelection: true, hasOpenPage: false })).toBe("content")
  })

  it("an open rail page shows even with no task selected", () => {
    expect(narrowSurface({ focusedPane: "workspace", hasSelection: false, hasOpenPage: true })).toBe("content")
  })

  it("nothing to show falls back to the sidebar", () => {
    expect(narrowSurface({ focusedPane: "workspace", hasSelection: false, hasOpenPage: false })).toBe("sidebar")
    expect(narrowSurface({ focusedPane: "files", hasSelection: false, hasOpenPage: false })).toBe("sidebar")
  })
})
