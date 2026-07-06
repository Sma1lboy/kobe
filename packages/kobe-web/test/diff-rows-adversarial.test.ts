import { describe, expect, it } from "vitest"
import { diffStat, parseDiffRows } from "../src/lib/diff-rows.ts"

/**
 * The gutter parser is fed `git diff` of UNTRUSTED worktree content — an agent
 * can write anything into a file, including text that mimics diff syntax. The
 * parser must not let that content masquerade as structure: header patterns
 * only match at the start of a line, and content lines always carry a +/-/space
 * marker, so diff-looking CONTENT can't corrupt the line numbers or the stat.
 */

describe("parseDiffRows — adversarial content", () => {
  it("treats an added line that mimics a hunk header as content, not a hunk", () => {
    const patch = `@@ -1,1 +1,3 @@
 context
+@@ -99,99 +99,99 @@
+diff --git a/evil b/evil
`
    const rows = parseDiffRows(patch)
    // Exactly one real hunk row; the diff-looking adds are 'add', not 'hunk'/'meta'.
    expect(rows.filter((r) => r.kind === "hunk")).toHaveLength(1)
    const adds = rows.filter((r) => r.kind === "add")
    expect(adds.map((r) => r.text)).toEqual([
      "+@@ -99,99 +99,99 @@",
      "+diff --git a/evil b/evil",
    ])
    // Line numbers stay sane (the fake header didn't reseed the counters).
    expect(adds.map((r) => r.newLn)).toEqual([2, 3])
    expect(diffStat(patch)).toEqual({ added: 2, deleted: 0 })
  })

  it("treats a space-prefixed 'diff --git' as a context line, not a file header", () => {
    const patch = `@@ -1,2 +1,2 @@
 diff --git a/x b/x
-old
+new
`
    const rows = parseDiffRows(patch)
    const ctx = rows.find((r) => r.text === " diff --git a/x b/x")
    expect(ctx?.kind).toBe("ctx")
    // It advances both counters like any context line (didn't reset inHunk).
    expect(ctx).toMatchObject({ oldLn: 1, newLn: 1 })
    expect(diffStat(patch)).toEqual({ added: 1, deleted: 1 })
  })
})
