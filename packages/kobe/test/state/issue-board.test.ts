/**
 * Pins the kanban column contract (state/issue-board.ts): columns derive
 * from the ISSUE's own lifecycle — done wins over a stale task link, a
 * linked issue is In progress regardless of stored status, everything else
 * (open/doing/hold) is Backlog — plus the newest-first ordering and the
 * Done-column cap. This is the same semantics the web Board pinned
 * (kobe-web board.test.ts); the TUI page renders straight from these
 * buckets, so a regression here IS a wrong board.
 */

import type { Issue } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import { describe, expect, test } from "vitest"
import {
  DONE_COLUMN_CAP,
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

  test("a linked issue is in progress regardless of stored status", () => {
    expect(issueColumnKey(issue({ id: 3, taskId: "01T" }))).toBe("in_progress")
    expect(issueColumnKey(issue({ id: 4, status: "hold", taskId: "01T" }))).toBe("in_progress")
  })

  test("open / doing / hold / empty-link are backlog", () => {
    expect(issueColumnKey(issue({ id: 5 }))).toBe("backlog")
    expect(issueColumnKey(issue({ id: 6, status: "doing" }))).toBe("backlog")
    expect(issueColumnKey(issue({ id: 7, status: "hold" }))).toBe("backlog")
    expect(issueColumnKey(issue({ id: 8, taskId: "" }))).toBe("backlog")
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
  test("buckets into the three columns in canonical order", () => {
    const board = buildIssueBoard([issue({ id: 1 }), issue({ id: 2, taskId: "01T" }), issue({ id: 3, status: "done" })])
    expect(board.map((col) => col.key)).toEqual(["backlog", "in_progress", "done"])
    expect(board.map((col) => col.issues.map((i) => i.id))).toEqual([[1], [2], [3]])
  })

  test("only the done column is capped; the overflow becomes hiddenCount", () => {
    const many = Array.from({ length: DONE_COLUMN_CAP + 5 }, (_, i) => issue({ id: i + 1, status: "done" as const }))
    const backlog = Array.from({ length: DONE_COLUMN_CAP + 5 }, (_, i) => issue({ id: 100 + i }))
    const board = buildIssueBoard([...many, ...backlog])
    const done = board.find((col) => col.key === "done")
    expect(done?.issues.length).toBe(DONE_COLUMN_CAP)
    expect(done?.hiddenCount).toBe(5)
    const bl = board.find((col) => col.key === "backlog")
    expect(bl?.issues.length).toBe(DONE_COLUMN_CAP + 5)
    expect(bl?.hiddenCount).toBe(0)
  })
})

describe("applyBoardAttention", () => {
  // in_progress (newest-first post-build): 3, 2, 1 · backlog: 10 · done: 20.
  const base = buildIssueBoard([
    issue({ id: 1, created: "2026-07-01", taskId: "T1" }),
    issue({ id: 2, created: "2026-07-02", taskId: "T2" }),
    issue({ id: 3, created: "2026-07-03", taskId: "T3" }),
    issue({ id: 10 }),
    issue({ id: 20, status: "done", taskId: "T20" }),
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
    expect(columns[1]).toBe(base[1])
    expect(attentionCount).toBe(0)
  })

  test("a vanished task (undefined state) stays in place", () => {
    const { columns, attentionCount } = applyBoardAttention(base, () => undefined)
    expect(inProgress(columns)).toEqual([3, 2, 1])
    expect(attentionCount).toBe(0)
  })

  test("done and backlog columns are never partitioned, even with blocked links", () => {
    const { columns } = applyBoardAttention(base, () => "permission_needed")
    expect(columns.find((c) => c.key === "done")?.issues.map((i) => i.id)).toEqual([20])
    expect(columns.find((c) => c.key === "backlog")?.issues.map((i) => i.id)).toEqual([10])
  })

  test("empty board is a no-op", () => {
    const { columns, attentionCount } = applyBoardAttention(buildIssueBoard([]), () => "error")
    expect(columns.every((c) => c.issues.length === 0)).toBe(true)
    expect(attentionCount).toBe(0)
  })
})

describe("moveBoardSelection", () => {
  // backlog: 1,2,3 · in_progress: (empty) · done: 4,5 — post-build shape.
  const columns = buildIssueBoard([
    issue({ id: 1, created: "2026-07-03" }),
    issue({ id: 2, created: "2026-07-02" }),
    issue({ id: 3, created: "2026-07-01" }),
    issue({ id: 4, status: "done" }),
    issue({ id: 5, status: "done" }),
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

  test("left/right skip empty columns and clamp the row", () => {
    // From backlog row 2 (id 3) → skips empty in_progress → done row 1.
    expect(moveBoardSelection(columns, 3, "right")).toBe(4)
    // From done row 1 back left lands in backlog row 1.
    expect(moveBoardSelection(columns, 4, "left")).toBe(2)
    // Board edge: stay put.
    expect(moveBoardSelection(columns, 1, "left")).toBe(1)
    expect(moveBoardSelection(columns, 4, "right")).toBe(4)
  })
})
