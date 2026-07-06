import { describe, expect, it } from "vitest"
import { computeViewport, viewportCursor } from "../../src/tui/panes/terminal/viewport"

describe("computeViewport", () => {
  it("offset 0 follows the bottom: last `height` rows", () => {
    expect(computeViewport(100, 24, 0)).toEqual({ start: 76, end: 100 })
  })

  it("short buffers render whole from row 0 (no underflow)", () => {
    expect(computeViewport(5, 24, 0)).toEqual({ start: 0, end: 5 })
    expect(computeViewport(0, 24, 0)).toEqual({ start: 0, end: 0 })
  })

  it("positive offsets move the window into history and clamp at the top", () => {
    expect(computeViewport(100, 24, 10)).toEqual({ start: 66, end: 90 })
    expect(computeViewport(100, 24, 999)).toEqual({ start: 0, end: 0 })
  })

  it("degenerate heights clamp to one row; negative offsets read as 0", () => {
    expect(computeViewport(10, 0, 0)).toEqual({ start: 9, end: 10 })
    expect(computeViewport(10, 4, -5)).toEqual({ start: 6, end: 10 })
  })
})

describe("viewportCursor", () => {
  const range = { start: 76, end: 100 }

  it("maps a live in-window cursor to viewport coordinates", () => {
    expect(viewportCursor({ x: 3, y: 80 }, 0, range)).toEqual({ x: 3, y: 4 })
  })

  it("hides the cursor while scrolled back or out of window", () => {
    expect(viewportCursor({ x: 3, y: 80 }, 5, range)).toBeNull()
    expect(viewportCursor({ x: 3, y: 10 }, 0, range)).toBeNull()
    expect(viewportCursor({ x: 3, y: 100 }, 0, range)).toBeNull()
    expect(viewportCursor(null, 0, range)).toBeNull()
  })
})
