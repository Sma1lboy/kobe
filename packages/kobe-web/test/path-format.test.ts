import { describe, expect, it } from "vitest"
import { tailPath } from "../src/lib/path-format.ts"


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
})
