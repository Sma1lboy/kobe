import { describe, expect, it } from "vitest"
import { diffStat, parseDiffRows } from "../src/lib/diff-rows.ts"


describe("parseDiffRows — adversarial content", () => {
  it("treats an added line that mimics a hunk header as content, not a hunk", () => {
    const patch = `@@ -1,1 +1,3 @@
 context
+@@ -99,99 +99,99 @@
+diff --git a/evil b/evil
`
    const rows = parseDiffRows(patch)
    expect(rows.filter((r) => r.kind === "hunk")).toHaveLength(1)
    const adds = rows.filter((r) => r.kind === "add")
    expect(adds.map((r) => r.text)).toEqual([
      "+@@ -99,99 +99,99 @@",
      "+diff --git a/evil b/evil",
    ])
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
    expect(ctx).toMatchObject({ oldLn: 1, newLn: 1 })
    expect(diffStat(patch)).toEqual({ added: 1, deleted: 1 })
  })
})
