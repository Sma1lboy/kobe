import { describe, expect, test } from "vitest"

import { truncateEnd, truncateStart } from "../../src/tui/lib/truncate"

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
