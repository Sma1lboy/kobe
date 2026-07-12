/**
 * Kanban column math for the daemon-owned issue store — framework-free so
 * the TUI page (and any future surface) renders from the same bucketing the
 * web Board pinned (kobe-web/src/lib/board.ts, docs/design/web-kanban.md).
 *
 * Columns bind to the ISSUE's own lifecycle, never task status:
 *   - Done        — the issue is `done` (wins over a stale task link).
 *   - In progress — the issue is linked to a task (`taskId` set = started).
 *   - Backlog     — everything else (open / doing / hold / unlinked).
 * `in_progress` is DERIVED from the link, not stored — `kobe api issue-update
 * --task <id>` is the "move card" gesture, `--task none` moves it back.
 */

import type { Issue } from "@sma1lboy/kobe-daemon/daemon/issues-store"

export type BoardColumnKey = "backlog" | "in_progress" | "done"

export const BOARD_COLUMN_ORDER: readonly BoardColumnKey[] = ["backlog", "in_progress", "done"]

/** The Done column accretes forever — only the newest slice renders, the
 *  rest becomes a "+N more" count (the web board's R1 done-growth policy). */
export const DONE_COLUMN_CAP = 20

export interface IssueBoardColumn {
  key: BoardColumnKey
  issues: Issue[]
  /** Issues beyond {@link DONE_COLUMN_CAP} — rendered as a count, not cards. */
  hiddenCount: number
}

export function issueColumnKey(issue: Issue): BoardColumnKey {
  if (issue.status === "done") return "done"
  if (issue.taskId !== undefined && issue.taskId !== "") return "in_progress"
  return "backlog"
}

/** Newest-created first; id desc as the tiebreak (`created` is day-granular). */
export function compareIssues(a: Issue, b: Issue): number {
  if (a.created !== b.created) return a.created < b.created ? 1 : -1
  return b.id - a.id
}

/** Bucket issues into the three render-ready columns, sorted, Done capped. */
export function buildIssueBoard(issues: readonly Issue[]): IssueBoardColumn[] {
  const buckets: Record<BoardColumnKey, Issue[]> = { backlog: [], in_progress: [], done: [] }
  for (const issue of issues) buckets[issueColumnKey(issue)].push(issue)
  return BOARD_COLUMN_ORDER.map((key) => {
    const sorted = buckets[key].sort(compareIssues)
    if (key !== "done" || sorted.length <= DONE_COLUMN_CAP) return { key, issues: sorted, hiddenCount: 0 }
    return { key, issues: sorted.slice(0, DONE_COLUMN_CAP), hiddenCount: sorted.length - DONE_COLUMN_CAP }
  })
}
