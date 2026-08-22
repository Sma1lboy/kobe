/**
 * Pins the kanban column contract (state/issue-board.ts): columns derive
 * from the ISSUE's own lifecycle — terminal (done) wins over a stale task
 * link, parked (hold / unknown-status) outranks the link too, a linked issue
 * is otherwise In progress, everything else (open/doing) is Backlog — plus
 * the newest-first ordering and the accreting-column caps. The TUI page
 * renders straight from these buckets, so a regression here IS a wrong board.
 */

import type { Issue } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import { describe, expect, test } from "vitest"
import {
  COLUMN_CAP,
  applyBoardAttention,
  buildIssueBoard,
  compareIssues,
  issueColumnKey,
  moveBoardSelection,
} from "../../src/state/issue-board"

function issue(over: Partial<Issue> & { id: number }): Issue {
  return { title: `t${over.id}`, status: "open", created: "2026-07-01", body: "", ...over }
}

describe("issueColumnKey", () => {
  test("done → done, even with a stale task link", () => {
    expect(issueColumnKey(issue({ id: 1, status: "done" }))).toBe("done")
    expect(issueColumnKey(issue({ id: 2, status: "done", taskId: "01T" }))).toBe("done")
  })

  test("hold → parked, WITH or without a task link (the disposition defect)", () => {
    // The original bug: a linked hold issue rendered as In progress.
    expect(issueColumnKey(issue({ id: 3, status: "hold", taskId: "01T" }))).toBe("parked")
    expect(issueColumnKey(issue({ id: 4, status: "hold" }))).toBe("parked")
  })

  test("an unknown status parks (fail-safe) — never backlog or done", () => {
    expect(issueColumnKey(issue({ id: 5, status: "wat" as Issue["status"] }))).toBe("parked")
  })

  test("a linked active issue is in progress", () => {
    expect(issueColumnKey(issue({ id: 6, taskId: "01T" }))).toBe("in_progress")
    expect(issueColumnKey(issue({ id: 7, status: "doing", taskId: "01T" }))).toBe("in_progress")
  })

  test("open / doing / empty-link are backlog", () => {
    expect(issueColumnKey(issue({ id: 8 }))).toBe("backlog")
    expect(issueColumnKey(issue({ id: 9, status: "doing" }))).toBe("backlog")
    expect(issueColumnKey(issue({ id: 10, taskId: "" }))).toBe("backlog")
  })
})

describe("compareIssues", () => {
  test("newest created first, id desc as the day-granular tiebreak", () => {
    const older = issue({ id: 9, created: "2026-07-01" })
    const newer = issue({ id: 1, created: "2026-07-02" })
    const sameDay = issue({ id: 2, created: "2026-07-01" })
    expect([older, newer, sameDay].sort(compareIssues).map((i) => i.id)).toEqual([1, 9, 2])
  })
})

describe("buildIssueBoard", () => {
  test("buckets into the four columns in canonical order", () => {
    const board = buildIssueBoard([
      issue({ id: 1 }),
      issue({ id: 2, taskId: "01T" }),
      issue({ id: 3, status: "hold", taskId: "01T" }),
      issue({ id: 4, status: "done" }),
    ])
    expect(board.map((col) => col.key)).toEqual(["backlog", "in_progress", "parked", "done"])
    expect(board.map((col) => col.issues.map((i) => i.id))).toEqual([[1], [2], [3], [4]])
  })

  test("parked and done both cap; active columns never do", () => {
    const n = COLUMN_CAP + 5
    const done = Array.from({ length: n }, (_, i) => issue({ id: i + 1, status: "done" as const }))
    const held = Array.from({ length: n }, (_, i) => issue({ id: 200 + i, status: "hold" as const }))
    const backlog = Array.from({ length: n }, (_, i) => issue({ id: 400 + i }))
    const board = buildIssueBoard([...done, ...held, ...backlog])
    for (const key of ["done", "parked"] as const) {
      const col = board.find((c) => c.key === key)
      expect(col?.issues.length).toBe(COLUMN_CAP)
      expect(col?.hiddenCount).toBe(5)
    }
    const bl = board.find((col) => col.key === "backlog")
    expect(bl?.issues.length).toBe(n)
    expect(bl?.hiddenCount).toBe(0)
  })
})

describe("applyBoardAttention", () => {
  // in_progress (newest-first post-build): 3, 2, 1 · backlog: 10 ·
  // parked: 30 (hold + linked + blocked engine) · done: 20.
  const base = buildIssueBoard([
    issue({ id: 1, created: "2026-07-01", taskId: "T1" }),
    issue({ id: 2, created: "2026-07-02", taskId: "T2" }),
    issue({ id: 3, created: "2026-07-03", taskId: "T3" }),
    issue({ id: 10 }),
    issue({ id: 20, status: "done", taskId: "T20" }),
    issue({ id: 30, status: "hold", taskId: "T30" }),
  ])
  const inProgress = (cols: readonly ReturnType<typeof buildIssueBoard>[number][]) =>
    cols.find((c) => c.key === "in_progress")?.issues.map((i) => i.id)

  test("floats blocked cards to the column head, stable within both groups", () => {
    const states = new Map([
      ["T1", "permission_needed"],
      ["T2", "running"],
    ])
    const { columns, attentionCount } = applyBoardAttention(base, (id) => states.get(id))
    expect(inProgress(columns)).toEqual([1, 3, 2])
    expect(attentionCount).toBe(1)
  })

  test("all attention states float; running/turn_complete/idle do not", () => {
    const states = new Map([
      ["T1", "error"],
      ["T2", "rate_limited"],
      ["T3", "turn_complete"],
    ])
    const { columns, attentionCount } = applyBoardAttention(base, (id) => states.get(id))
    expect(inProgress(columns)).toEqual([2, 1, 3])
    expect(attentionCount).toBe(2)
  })

  test("no attention → columns unchanged (same references), count 0", () => {
    const { columns, attentionCount } = applyBoardAttention(base, () => "running")
    expect(columns).toEqual(base)
    expect(columns.find((c) => c.key === "in_progress")).toBe(base.find((c) => c.key === "in_progress"))
    expect(attentionCount).toBe(0)
  })

  test("a vanished task (undefined state) stays in place", () => {
    const { columns, attentionCount } = applyBoardAttention(base, () => undefined)
    expect(inProgress(columns)).toEqual([3, 2, 1])
    expect(attentionCount).toBe(0)
  })

  test("parked/done/backlog are never partitioned nor counted, even with blocked links", () => {
    // Issue 30 is parked AND its engine is permission_needed — that state is
    // often WHY it was parked, so it neither floats nor counts as attention.
    const { columns, attentionCount } = applyBoardAttention(base, () => "permission_needed")
    expect(columns.find((c) => c.key === "parked")?.issues.map((i) => i.id)).toEqual([30])
    expect(columns.find((c) => c.key === "done")?.issues.map((i) => i.id)).toEqual([20])
    expect(columns.find((c) => c.key === "backlog")?.issues.map((i) => i.id)).toEqual([10])
    expect(attentionCount).toBe(3)
  })

  test("empty board is a no-op", () => {
    const { columns, attentionCount } = applyBoardAttention(buildIssueBoard([]), () => "error")
    expect(columns.every((c) => c.issues.length === 0)).toBe(true)
    expect(attentionCount).toBe(0)
  })
})

describe("moveBoardSelection", () => {
  // backlog: 1,2,3 · in_progress: (empty) · parked: 6 · done: 5,4
  // (same-day → id desc within a column).
  const columns = buildIssueBoard([
    issue({ id: 1, created: "2026-07-03" }),
    issue({ id: 2, created: "2026-07-02" }),
    issue({ id: 3, created: "2026-07-01" }),
    issue({ id: 4, status: "done" }),
    issue({ id: 5, status: "done" }),
    issue({ id: 6, status: "hold" }),
  ])

  test("anchors on the first visible card when nothing (or a stale id) is selected", () => {
    expect(moveBoardSelection(columns, null, "down")).toBe(1)
    expect(moveBoardSelection(columns, 99, "right")).toBe(1)
  })

  test("null only on an empty board", () => {
    expect(moveBoardSelection(buildIssueBoard([]), null, "down")).toBeNull()
  })

  test("up/down step within a column and clamp at the edges", () => {
    expect(moveBoardSelection(columns, 1, "down")).toBe(2)
    expect(moveBoardSelection(columns, 3, "down")).toBe(3)
    expect(moveBoardSelection(columns, 2, "up")).toBe(1)
    expect(moveBoardSelection(columns, 1, "up")).toBe(1)
  })

  test("left/right skip empty columns and clamp the row across all four", () => {
    // From backlog row 2 (id 3) → skips empty in_progress → parked row 0.
    expect(moveBoardSelection(columns, 3, "right")).toBe(6)
    // Parked row 0 → done row 0.
    expect(moveBoardSelection(columns, 6, "right")).toBe(5)
    // From done row 1 (id 4) back left → parked's single card (row clamp).
    expect(moveBoardSelection(columns, 4, "left")).toBe(6)
    // Board edge: stay put.
    expect(moveBoardSelection(columns, 1, "left")).toBe(1)
    expect(moveBoardSelection(columns, 4, "right")).toBe(4)
  })

  test("a card moving columns between renders re-anchors, not strands", () => {
    // Selection was on id 7 (linked, in_progress); a refetch marks it hold →
    // it now lives in parked. The id is still findable, so the cursor
    // follows the card instead of falling back to first-visible.
    const before = buildIssueBoard([issue({ id: 7, taskId: "T7" }), issue({ id: 8 })])
    expect(moveBoardSelection(before, 7, "down")).toBe(7)
    const after = buildIssueBoard([issue({ id: 7, status: "hold", taskId: "T7" }), issue({ id: 8 })])
    expect(moveBoardSelection(after, 7, "left")).toBe(8)
    expect(moveBoardSelection(after, 7, "down")).toBe(7)
  })
})
