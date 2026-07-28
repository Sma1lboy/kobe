import { describe, expect, it } from "vitest"
import {
  type DiffComment,
  buildDiffReview,
  commentRange,
  computeReviewPaint,
  diffCommentsKey,
  formatDiffComment,
  formatDiffComments,
  markAllSent,
  unifiedDiffRows,
  unsentComments,
} from "../../src/tui/ops/diff-comments"

function comment(over: Partial<DiffComment>): DiffComment {
  return { id: "c1", filePath: "a.ts", line: 1, body: "note", createdAt: 1, ...over }
}

describe("formatDiffComment", () => {
  it("renders File / Line / quoted comment", () => {
    expect(formatDiffComment(comment({ filePath: "src/a.ts", line: 12, body: "rename this" }))).toBe(
      'File: src/a.ts\nLine: 12\nUser comment: "rename this"',
    )
  })

  it("renders a range as Lines: start-end", () => {
    expect(formatDiffComment(comment({ line: 14, startLine: 12 }))).toContain("Lines: 12-14")
  })

  it("treats startLine === line as a single line", () => {
    expect(formatDiffComment(comment({ line: 5, startLine: 5 }))).toContain("Line: 5")
  })

  it("escapes backslashes, quotes, and newlines (orca contract)", () => {
    const out = formatDiffComment(comment({ body: 'a\\b "quoted"\r\nnext' }))
    expect(out).toContain('User comment: "a\\\\b \\"quoted\\"\\r\\nnext"')
  })

  it("joins multiple comments with a blank line", () => {
    const out = formatDiffComments([comment({ line: 1 }), comment({ line: 2 })])
    expect(out.split("\n\n")).toHaveLength(2)
  })
})

const SAMPLE_DIFF = [
  "diff --git a/a.ts b/a.ts",
  "index 1111111..2222222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1",
  "-const b = 2",
  "+const b = 3",
  "+const c = 4",
  " const d = 5",
  "@@ -10,2 +11,2 @@",
  " x",
  "-y",
  "+z",
  "\\ No newline at end of file",
  "",
].join("\n")

describe("unifiedDiffRows", () => {
  it("mirrors opentui's unified row order with display line numbers", () => {
    expect(unifiedDiffRows(SAMPLE_DIFF)).toEqual([
      { kind: "ctx", line: 1 },
      { kind: "del", line: 2 },
      { kind: "add", line: 2 },
      { kind: "add", line: 3 },
      { kind: "ctx", line: 4 },
      { kind: "ctx", line: 11 },
      { kind: "del", line: 11 },
      { kind: "add", line: 12 },
    ])
  })

  it("returns no rows for non-diff text", () => {
    expect(unifiedDiffRows("just some file contents\nno hunks here")).toEqual([])
  })
})

describe("commentRange", () => {
  const rows = unifiedDiffRows(SAMPLE_DIFF)

  it("is a single line without an anchor", () => {
    expect(commentRange(rows, 3, null)).toEqual({ line: 3 })
  })

  it("spans anchor..cursor in either direction", () => {
    expect(commentRange(rows, 4, 2)).toEqual({ line: 4, startLine: 2 })
    expect(commentRange(rows, 2, 4)).toEqual({ line: 4, startLine: 2 })
  })

  it("collapses a non-monotonic range to the cursor line", () => {
    // rows 1 (del old:2) → 2 (add new:2): display lines don't order.
    expect(commentRange(rows, 2, 1)).toEqual({ line: 2 })
  })

  it("returns null when the cursor is out of range", () => {
    expect(commentRange(rows, 99, null)).toBeNull()
  })
})

describe("computeReviewPaint", () => {
  const rows = unifiedDiffRows(SAMPLE_DIFF)

  it("marks the cursor row", () => {
    const paint = computeReviewPaint(rows, 0, null, [], "a.ts")
    expect(paint.get(0)).toBe("cursor")
    expect(paint.size).toBe(1)
  })

  it("marks the anchor..cursor range with the cursor winning", () => {
    const paint = computeReviewPaint(rows, 3, 1, [], "a.ts")
    expect(paint.get(1)).toBe("range")
    expect(paint.get(2)).toBe("range")
    expect(paint.get(3)).toBe("cursor")
  })

  it("marks rows covered by UNSENT comments on this file only", () => {
    const comments = [
      comment({ line: 3, startLine: 2 }),
      comment({ id: "c2", line: 4, sentAt: 99 }),
      comment({ id: "c3", filePath: "other.ts", line: 1 }),
    ]
    const paint = computeReviewPaint(rows, 0, null, comments, "a.ts")
    // display lines 2..3 → rows 1 (del old:2), 2 (add new:2), 3 (add new:3)
    expect(paint.get(1)).toBe("note")
    expect(paint.get(2)).toBe("note")
    expect(paint.get(3)).toBe("note")
    expect(paint.get(4)).toBeUndefined() // sent comment (line 4) not painted
    expect(paint.get(0)).toBe("cursor")
  })
})

describe("sent bookkeeping", () => {
  it("unsentComments / markAllSent round-trip", () => {
    const list = [comment({ id: "a" }), comment({ id: "b", sentAt: 5 })]
    expect(unsentComments(list).map((c) => c.id)).toEqual(["a"])
    const sent = markAllSent(list, 42)
    expect(sent.map((c) => c.sentAt)).toEqual([42, 5])
    expect(unsentComments(sent)).toEqual([])
  })
})

describe("buildDiffReview", () => {
  function fakeKv(): {
    store: Map<string, unknown>
    get: (k: string, d?: unknown) => unknown
    set: (k: string, v: unknown) => void
  } {
    const store = new Map<string, unknown>()
    return {
      store,
      get: (k, d) => store.get(k) ?? d,
      set: (k, v) => store.set(k, v),
    }
  }

  it("adds notes with generated id/createdAt under the task key", () => {
    const kv = fakeKv()
    const review = buildDiffReview(kv, "t1", () => {})
    review.add({ filePath: "a.ts", line: 3, body: "note one" })
    review.add({ filePath: "a.ts", line: 5, startLine: 4, body: "note two" })
    const stored = kv.store.get(diffCommentsKey("t1")) as DiffComment[]
    expect(stored).toHaveLength(2)
    expect(stored[0]?.id).toBeTruthy()
    expect(stored[0]?.createdAt).toBeGreaterThan(0)
    expect(stored[1]?.startLine).toBe(4)
  })

  it("send() batches ALL unsent notes into one prompt and marks them sent", () => {
    const kv = fakeKv()
    const sends: string[] = []
    const review = buildDiffReview(kv, "t1", (text) => sends.push(text))
    review.add({ filePath: "a.ts", line: 3, body: "first" })
    review.add({ filePath: "b.ts", line: 7, body: "second" })
    review.send()
    expect(sends).toHaveLength(1)
    expect(sends[0]).toContain("File: a.ts")
    expect(sends[0]).toContain("File: b.ts")
    expect(sends[0]).toContain('User comment: "first"')
    const stored = kv.store.get(diffCommentsKey("t1")) as DiffComment[]
    expect(stored.every((c) => c.sentAt !== undefined)).toBe(true)
    // A second send with nothing unsent is a no-op.
    review.send()
    expect(sends).toHaveLength(1)
  })
})
