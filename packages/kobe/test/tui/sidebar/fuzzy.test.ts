import { describe, expect, test } from "vitest"
import { fuzzyMatch } from "../../../src/tui/panes/sidebar/fuzzy"

describe("fuzzyMatch — case-insensitive subsequence test", () => {
  test("empty query is a universal match", () => {
    expect(fuzzyMatch("", "anything")).toBe(true)
    expect(fuzzyMatch("", "")).toBe(true)
  })

  test("subsequence (gaps allowed) — characters in order", () => {
    expect(fuzzyMatch("kbe", "kobe")).toBe(true)
    expect(fuzzyMatch("csk", "closure-stack-k8s")).toBe(true)
    expect(fuzzyMatch("abc", "axbxc")).toBe(true)
  })

  test("substring is a special case of subsequence", () => {
    expect(fuzzyMatch("obe", "kobe")).toBe(true)
    expect(fuzzyMatch("stack", "closure-stack-k8s")).toBe(true)
  })

  test("order matters — chars present but reordered don't match", () => {
    expect(fuzzyMatch("ekb", "kobe")).toBe(false)
    expect(fuzzyMatch("xba", "abcde")).toBe(false)
  })

  test("case-insensitive on both sides", () => {
    expect(fuzzyMatch("CSK", "closure-stack-k8s")).toBe(true)
    expect(fuzzyMatch("kbe", "KOBE")).toBe(true)
    expect(fuzzyMatch("aB", "AaBb")).toBe(true)
  })

  test("missing chars → no match", () => {
    expect(fuzzyMatch("xyz", "kobe")).toBe(false)
    expect(fuzzyMatch("kobex", "kobe")).toBe(false)
  })

  test("query longer than haystack → no match unless query is empty-ish", () => {
    expect(fuzzyMatch("kobe-fork", "kobe")).toBe(false)
  })

  test("whitespace counts as a literal char (not stripped)", () => {
    // We intentionally don't trim the query — callers can if they want.
    expect(fuzzyMatch("k b", "k b")).toBe(true)
    expect(fuzzyMatch("k b", "kb")).toBe(false)
  })
})
