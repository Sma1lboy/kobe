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
import { DONE_COLUMN_CAP, buildIssueBoard, compareIssues, issueColumnKey } from "../../src/state/issue-board"

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
