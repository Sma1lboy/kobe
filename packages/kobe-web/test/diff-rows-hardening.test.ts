import { describe, expect, it } from "vitest"
import { diffStat, parseDiffRows } from "../src/lib/diff-rows.ts"

/**
 * Real-world git patch shapes the gutter parser must survive without
 * mis-tagging a header as a content row (which would corrupt line numbers and
 * inflate the +/- stat). diff-rows.test.ts covers the modify case; these lock
 * new-file / binary / rename / no-newline / single-line-hunk shapes so a future
 * trim of META_PREFIXES or HUNK_RE can't silently regress them. Coverage only.
 */

describe("parseDiffRows — real git shapes", () => {
  it("treats a full new-file header block as meta and counts the adds", () => {
    const patch = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+a
+b
`
    const rows = parseDiffRows(patch)
    // The 5 header lines (incl. "new file mode" and the /dev/null ---) are meta.
    expect(rows.slice(0, 5).every((r) => r.kind === "meta")).toBe(true)
    expect(rows.filter((r) => r.kind === "add").map((r) => r.newLn)).toEqual([
      1, 2,
    ])
    expect(diffStat(patch)).toEqual({ added: 2, deleted: 0 })
  })

  it("tags a Binary files line as meta, not a context row", () => {
    const patch = `diff --git a/img.png b/img.png
index 111..222 100644
Binary files a/img.png and b/img.png differ
`
    const rows = parseDiffRows(patch)
    expect(rows.every((r) => r.kind === "meta")).toBe(true)
    // No content rows means no bogus line-number advance and a zero stat.
    expect(diffStat(patch)).toEqual({ added: 0, deleted: 0 })
  })

  it("tags rename headers (similarity/rename from/to) as meta", () => {
    const patch = `diff --git a/old.ts b/new.ts
similarity index 95%
rename from old.ts
rename to new.ts
`
    expect(parseDiffRows(patch).every((r) => r.kind === "meta")).toBe(true)
    expect(diffStat(patch)).toEqual({ added: 0, deleted: 0 })
  })

  it("treats a trailing '\\ No newline' marker as meta (not a -/+ row)", () => {
    const patch = `@@ -1,1 +1,1 @@
-old
+new
\\ No newline at end of file
`
    const rows = parseDiffRows(patch)
    const last = rows[rows.length - 1]
    expect(last.kind).toBe("meta")
    expect(last.text).toBe("\\ No newline at end of file")
    // The marker must not be counted as an add/del.
    expect(diffStat(patch)).toEqual({ added: 1, deleted: 1 })
  })

  it("parses a single-line hunk header with no ,count", () => {
    const patch = `@@ -5 +7 @@
-x
+y
`
    const rows = parseDiffRows(patch)
    expect(rows.find((r) => r.kind === "del")).toMatchObject({ oldLn: 5 })
    expect(rows.find((r) => r.kind === "add")).toMatchObject({ newLn: 7 })
  })
})
