import { describe, expect, it } from "vitest"
import { NARROW_BREAKPOINT, isNarrowWidth } from "../../src/tui-react/lib/narrow-mode"

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
