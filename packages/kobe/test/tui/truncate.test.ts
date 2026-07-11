import { describe, expect, test } from "vitest"

import { approxCharCells } from "../../src/lib/display-width"
import { truncateEnd, truncateEndCells, truncateStart } from "../../src/tui/lib/truncate"

describe("truncateEnd — keep the prefix", () => {
  test("returns the string unchanged when it fits the budget", () => {
    expect(truncateEnd("feat/x", 10)).toBe("feat/x")
    expect(truncateEnd("feat/x", 6)).toBe("feat/x")
  })

  test("keeps the prefix and appends a trailing …", () => {
    expect(truncateEnd("delta_project", 6)).toBe("delta…")
  })

  test("never bisects a surrogate pair — emoji stay intact", () => {
    // Each 🎉 is one code point but two UTF-16 code units; a `.slice` by
    // .length would cut mid-emoji and emit a lone surrogate (→ �).
    expect(truncateEnd("🎉🎉🎉🎉-tail", 4)).toBe("🎉🎉🎉…")
  })

  test("max <= 0 leaves no room, so yields the empty string", () => {
    expect(truncateEnd("anything", 0)).toBe("")
    expect(truncateEnd("anything", -3)).toBe("")
  })
})

describe("truncateEndCells — keep the prefix within a CELL budget", () => {
  test("returns the string unchanged when its cells fit the budget", () => {
    // 3 CJK glyphs = 6 cells under the approx measure.
    expect(truncateEndCells("新任务", 6, approxCharCells)).toBe("新任务")
    expect(truncateEndCells("open", 8, approxCharCells)).toBe("open")
  })

  test("reserves one cell for the ellipsis and never splits a wide glyph", () => {
    // Budget 4 → 3 cells of content: the second 2-cell glyph won't fit.
    expect(truncateEndCells("新任务", 4, approxCharCells)).toBe("新…")
    // Narrow-only strings clip like truncateEnd.
    expect(truncateEndCells("open worktree", 8, approxCharCells)).toBe("open wo…")
  })

  test("maxCells <= 0 leaves no room, so yields the empty string", () => {
    expect(truncateEndCells("任务", 0, approxCharCells)).toBe("")
    expect(truncateEndCells("任务", -2, approxCharCells)).toBe("")
  })
})

describe("truncateStart — keep the tail", () => {
  test("returns the string unchanged when it fits the budget", () => {
    expect(truncateStart("src/a.ts", 20)).toBe("src/a.ts")
    expect(truncateStart("src/a.ts", 8)).toBe("src/a.ts")
  })

  test("keeps the tail (leaf) and marks the elided prefix with a leading …", () => {
    expect(truncateStart("components/sidebar/Sidebar.tsx", 14)).toBe("…r/Sidebar.tsx")
  })

  test("never bisects a surrogate pair — emoji stay intact", () => {
    expect(truncateStart("src/aaaaa-🎉🎉🎉.ts", 8)).toBe("…-🎉🎉🎉.ts")
  })

  test("max <= 0 leaves no room, so yields the empty string", () => {
    expect(truncateStart("a/b/c.ts", 0)).toBe("")
    expect(truncateStart("a/b/c.ts", -1)).toBe("")
  })
})
