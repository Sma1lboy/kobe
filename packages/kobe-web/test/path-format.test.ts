import { describe, expect, it } from "vitest"
import { tailPath } from "../src/lib/path-format.ts"

/**
 * tailPath fits a path into a fixed-width slot by keeping the END (the
 * filename) and prefixing an ellipsis. Shared by the rail and the diff file
 * list, so the truncation must be exact: result ≤ max, the tail preserved.
 */

describe("tailPath", () => {
  it("returns a path within budget unchanged", () => {
    expect(tailPath("/a/b.ts", 36)).toBe("/a/b.ts")
  })

  it("returns a path exactly at the budget unchanged", () => {
    expect(tailPath("abcd", 4)).toBe("abcd")
  })

  it("truncates an over-budget path to at most max chars", () => {
    const out = tailPath("abcdef", 4)
    expect(out).toBe("…def")
    expect(out).toHaveLength(4)
  })

  it("keeps the END of the path (the filename), prefixed with …", () => {
    const out = tailPath("/very/long/path/to/file.ts", 10)
    expect(out.startsWith("…")).toBe(true)
    expect(out.endsWith("file.ts")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(10)
  })

  it("defaults to a 36-char budget", () => {
    const long = "/".concat("a".repeat(50))
    expect(tailPath(long)).toHaveLength(36)
    expect(tailPath(long).startsWith("…")).toBe(true)
  })

  it("does not split a surrogate pair at the truncation seam", () => {
    // Each 📁 (U+1F4C1) is two UTF-16 units, so a code-unit .slice can begin
    // the kept tail on a lone low surrogate and emit a `�` glyph. Iterating by
    // code point keeps every emoji intact.
    const out = tailPath("📁".repeat(20), 8)
    expect(out.startsWith("…")).toBe(true)
    expect(out).not.toContain("�")
    // Leading `…` + 7 whole emoji, none bisected.
    expect([...out]).toHaveLength(8)
    expect(out).toBe(`…${"📁".repeat(7)}`)
  })

  it("counts astral characters by code point, not UTF-16 unit, when within budget", () => {
    // 10 emoji is 20 UTF-16 units but only 10 code points — well within a
    // 36-code-point budget, so the path is returned unchanged rather than
    // needlessly truncated.
    const path = "📁".repeat(10)
    expect(tailPath(path)).toBe(path)
  })
})
