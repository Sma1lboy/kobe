import { describe, expect, it } from "vitest"
import { fuzzyScore } from "../src/lib/fuzzy.ts"

/**
 * fuzzyScore ranks the command palette's task search. The contract: a
 * subsequence match (chars in order) returns a score where LOWER is better
 * (earlier + tighter = lower), a non-match returns null, an empty query
 * matches everything at the best score, and matching is case-insensitive.
 */

describe("fuzzyScore — match / no-match", () => {
  it("matches a contiguous substring", () => {
    expect(fuzzyScore("abc", "abc")).not.toBeNull()
    expect(fuzzyScore("ell", "hello")).not.toBeNull()
  })

  it("matches a non-contiguous subsequence (chars in order)", () => {
    expect(fuzzyScore("hlo", "hello")).not.toBeNull()
  })

  it("returns null when a char is missing", () => {
    expect(fuzzyScore("xyz", "hello")).toBeNull()
  })

  it("returns null when chars are present but out of order", () => {
    expect(fuzzyScore("ba", "ab")).toBeNull()
  })

  it("matches everything at score 0 for an empty query", () => {
    expect(fuzzyScore("", "anything")).toBe(0)
    expect(fuzzyScore("", "")).toBe(0)
  })

  it("is case-insensitive both ways", () => {
    expect(fuzzyScore("AB", "ab")).toBe(fuzzyScore("ab", "ab"))
    expect(fuzzyScore("ab", "AB")).toBe(fuzzyScore("ab", "ab"))
  })
})

describe("fuzzyScore — ranking (lower is better)", () => {
  it("scores a tighter (contiguous) match below a spread-out one", () => {
    const tight = fuzzyScore("abc", "abc") as number
    const spread = fuzzyScore("abc", "axbxc") as number
    expect(tight).toBeLessThan(spread)
  })

  it("scores an earlier match below a later one", () => {
    const early = fuzzyScore("a", "a___") as number
    const late = fuzzyScore("a", "___a") as number
    expect(early).toBeLessThan(late)
  })

  it("ranks a list so the best candidate sorts first", () => {
    const cands = ["my-feature-branch", "feature", "refactor-feat"]
    const ranked = cands
      .map((c) => ({ c, s: fuzzyScore("feat", c) }))
      .filter((m): m is { c: string; s: number } => m.s !== null)
      .sort((a, b) => a.s - b.s)
    expect(ranked).toHaveLength(3)
    // "feature" — the tightest, earliest hit — must rank first.
    expect(ranked[0].c).toBe("feature")
  })
})
