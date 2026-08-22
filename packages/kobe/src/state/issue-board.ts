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
import { statusDisposition } from "@sma1lboy/kobe-daemon/daemon/status-disposition"

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

export type BoardDirection = "up" | "down" | "left" | "right"

/**
 * Keyboard cursor movement over the RENDERED board (post-cap columns):
 * up/down step within a column (clamped at the edges), left/right jump to
 * the adjacent non-empty column keeping the row (clamped to its length).
 * A missing/stale selection re-anchors on the first visible card, so a
 * cursor key always lands somewhere on a non-empty board; null only when
 * the board has no cards at all.
 */
export function moveBoardSelection(
  columns: readonly IssueBoardColumn[],
  currentId: number | null,
  dir: BoardDirection,
): number | null {
  const firstVisible = columns.find((column) => column.issues.length > 0)?.issues[0]?.id ?? null
  if (currentId == null) return firstVisible
  let col = -1
  let row = -1
  for (const [c, column] of columns.entries()) {
    const r = column.issues.findIndex((issue) => issue.id === currentId)
    if (r !== -1) {
      col = c
      row = r
      break
    }
  }
  if (col === -1) return firstVisible
  if (dir === "up" || dir === "down") {
    const column = columns[col]?.issues ?? []
    const next = dir === "up" ? row - 1 : row + 1
    return column[Math.max(0, Math.min(next, column.length - 1))]?.id ?? currentId
  }
  const step = dir === "left" ? -1 : 1
  for (let c = col + step; c >= 0 && c < columns.length; c += step) {
    const column = columns[c]?.issues ?? []
    if (column.length === 0) continue
    return column[Math.min(row, column.length - 1)]?.id ?? currentId
  }
  return currentId
}

export function issueColumnKey(issue: Issue): BoardColumnKey {
  // Terminal disposition (today: `done`) wins over a stale task link; an
  // UNKNOWN status parks — it must never render as finished.
  if (statusDisposition(issue.status) === "terminal") return "done"
  if (issue.taskId !== undefined && issue.taskId !== "") return "in_progress"
  return "backlog"
}

/** Activity states where the linked engine is BLOCKED and won't progress on
 *  its own — a permission prompt, a dead turn, or a quota wall. These float
 *  to the head of In progress as the "needs you" group. `turn_complete` is
 *  deliberately excluded: a finished turn is the normal end state, and
 *  floating every finished card would drown the actually-blocked ones.
 *  String-typed (like notify-state's `attentionKindFor`) so this module
 *  stays free of the engine import. */
export const BOARD_ATTENTION_STATES: readonly string[] = ["permission_needed", "rate_limited", "error"]

export function isBoardAttentionState(state: string | undefined): boolean {
  return state !== undefined && BOARD_ATTENTION_STATES.includes(state)
}

/**
 * Rendering-only attention partition: float In-progress cards whose linked
 * task is blocked on the user to the head of their column (order stable
 * within both groups) and report the group size. Nothing persisted changes —
 * the card stays In progress semantically; only the view order does.
 * Unlinked issues and vanished tasks (`stateOf` → undefined) stay in place.
 * Attention can only exist in In progress: activity needs a task link, and
 * a `done` issue outranks its link in {@link issueColumnKey}.
 */
export function applyBoardAttention(
  columns: readonly IssueBoardColumn[],
  stateOf: (taskId: string) => string | undefined,
): { columns: readonly IssueBoardColumn[]; attentionCount: number } {
  let attentionCount = 0
  const next = columns.map((col) => {
    if (col.key !== "in_progress") return col
    const attention: Issue[] = []
    const rest: Issue[] = []
    for (const issue of col.issues) {
      const linked = issue.taskId !== undefined && issue.taskId !== ""
      if (linked && isBoardAttentionState(stateOf(issue.taskId as string))) attention.push(issue)
      else rest.push(issue)
    }
    attentionCount = attention.length
    return attention.length === 0 ? col : { ...col, issues: [...attention, ...rest] }
  })
  return { columns: next, attentionCount }
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
