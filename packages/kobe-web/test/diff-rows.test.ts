import { describe, expect, it } from "vitest"
import { diffStat, parseDiffRows } from "../src/lib/diff-rows.ts"


const PATCH = `diff --git a/foo.ts b/foo.ts
index 1234567..89abcde 100644
--- a/foo.ts
+++ b/foo.ts
@@ -10,4 +10,5 @@ export function foo() {
 context one
-removed line
+added line a
+added line b
 context two
`

describe("parseDiffRows", () => {
  it("tags file-header lines as meta with no line numbers", () => {
    const rows = parseDiffRows(PATCH)
    const meta = rows.filter((r) => r.kind === "meta")
    expect(meta.length).toBeGreaterThanOrEqual(4)
    for (const r of meta) {
      expect(r.oldLn).toBeNull()
      expect(r.newLn).toBeNull()
    }
  })

  it("parses the hunk header and seeds both counters", () => {
    const rows = parseDiffRows(PATCH)
    const hunk = rows.find((r) => r.kind === "hunk")
    expect(hunk).toBeTruthy()
    expect(hunk?.oldLn).toBeNull()
    expect(hunk?.newLn).toBeNull()
  })

  it("advances old/new line numbers correctly", () => {
    const rows = parseDiffRows(PATCH).filter(
      (r) => r.kind === "add" || r.kind === "del" || r.kind === "ctx",
    )
    expect(rows[0]).toMatchObject({ kind: "ctx", oldLn: 10, newLn: 10 })
    expect(rows[1]).toMatchObject({ kind: "del", oldLn: 11, newLn: null })
    expect(rows[2]).toMatchObject({ kind: "add", oldLn: null, newLn: 11 })
    expect(rows[3]).toMatchObject({ kind: "add", oldLn: null, newLn: 12 })
    expect(rows[4]).toMatchObject({ kind: "ctx", oldLn: 12, newLn: 13 })
  })

  it("handles multiple hunks, resetting counters per hunk header", () => {
    const patch = `@@ -1,2 +1,2 @@
 a
-b
+B
@@ -50,1 +50,1 @@
-x
+X
`
    const rows = parseDiffRows(patch)
    const hunks = rows.filter((r) => r.kind === "hunk")
    expect(hunks).toHaveLength(2)
    const second = rows.slice(rows.indexOf(hunks[1]) + 1)
    expect(second[0]).toMatchObject({ kind: "del", oldLn: 50 })
    expect(second[1]).toMatchObject({ kind: "add", newLn: 50 })
  })

  it("returns an empty array for an empty patch", () => {
    expect(parseDiffRows("")).toEqual([{ kind: "meta", oldLn: null, newLn: null, text: "" }])
  })

  it("resets hunk state at a new file header (concatenated patch)", () => {
    const patch = `diff --git a/one.ts b/one.ts
--- a/one.ts
+++ b/one.ts
@@ -1,1 +1,1 @@
-old
+new
diff --git a/two.ts b/two.ts
--- a/two.ts
+++ b/two.ts
@@ -1,1 +1,1 @@
-x
+y
`
    const rows = parseDiffRows(patch)
    const secondHeaderIdx = rows.findIndex((r) => r.text === "diff --git a/two.ts b/two.ts")
    expect(secondHeaderIdx).toBeGreaterThan(0)
    const secondHeaders = rows.slice(secondHeaderIdx, secondHeaderIdx + 3)
    expect(secondHeaders.every((r) => r.kind === "meta")).toBe(true)
    expect(diffStat(patch)).toEqual({ added: 2, deleted: 2 })
  })
})

describe("diffStat", () => {
  it("counts added/removed lines, excluding +++/--- file headers", () => {
    expect(diffStat(PATCH)).toEqual({ added: 2, deleted: 1 })
  })

  it("is zero for an empty patch", () => {
    expect(diffStat("")).toEqual({ added: 0, deleted: 0 })
  })

  it("counts an all-added (new file) patch", () => {
    const patch = `@@ -0,0 +1,3 @@
+line one
+line two
+line three
`
    expect(diffStat(patch)).toEqual({ added: 3, deleted: 0 })
  })
})
