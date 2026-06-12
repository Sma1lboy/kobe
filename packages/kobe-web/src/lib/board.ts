/**
 * Kanban board logic — pure column math shared out of the Board view so
 * bucketing, ordering, and visibility are unit-testable (the activity.ts /
 * triage.ts precedent).
 *
 * Columns bind to the PERSISTED `Task.status` lifecycle, never the transient
 * engine activity — activity is a per-card signal lamp, not a drop target
 * (docs/design/web-kanban.md). Archived tasks and `kind: "main"` project rows
 * are not workflow cards, so they never enter the board (the Overview
 * precedent).
 */

import type { Task } from "./types.ts"

export interface BoardColumnSpec {
  key: string
  title: string
  /** Tailwind text color for the column header. */
  accent: string
  /** Rendered even when empty; fold-away columns appear only with cards. */
  alwaysVisible: boolean
}

/** Canonical column order — mirrors the daemon's TaskStatus enum
 *  (packages/kobe/src/types/task.ts). `error`/`canceled` fold away when
 *  empty so the resting board stays four columns. */
export const BOARD_COLUMNS: readonly BoardColumnSpec[] = [
  {
    key: "backlog",
    title: "Backlog",
    accent: "text-subtle",
    alwaysVisible: true,
  },
  {
    key: "in_progress",
    title: "In progress",
    accent: "text-kobe-orange",
    alwaysVisible: true,
  },
  {
    key: "in_review",
    title: "In review",
    accent: "text-kobe-blue",
    alwaysVisible: true,
  },
  {
    key: "done",
    title: "Done",
    accent: "text-kobe-green",
    alwaysVisible: true,
  },
  {
    key: "error",
    title: "Error",
    accent: "text-kobe-red",
    alwaysVisible: false,
  },
  {
    key: "canceled",
    title: "Canceled",
    accent: "text-muted",
    alwaysVisible: false,
  },
]

export interface BoardColumn extends BoardColumnSpec {
  tasks: Task[]
}

/** Only worktree tasks flow across the board. */
export function isBoardTask(task: Task): boolean {
  return !task.archived && task.kind !== "main"
}

function taskUpdatedMs(task: Task): number {
  const parsed = Date.parse(task.updatedAt || task.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Within a column: pinned cards float, then newest activity first (id as a
 *  stable tiebreak). Persisted ordering (`position`) is M3. */
export function compareCards(a: Task, b: Task): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  const byTime = taskUpdatedMs(b) - taskUpdatedMs(a)
  if (byTime !== 0) return byTime
  return b.id.localeCompare(a.id)
}

/**
 * Bucket tasks into render-ready columns. A status outside the canonical
 * enum (a newer daemon) must not drop cards — it becomes a trailing dynamic
 * column titled by the raw status string.
 */
export function buildBoard(tasks: Task[]): BoardColumn[] {
  const byStatus = new Map<string, Task[]>()
  for (const task of tasks) {
    if (!isBoardTask(task)) continue
    const key = task.status || "backlog"
    const bucket = byStatus.get(key)
    if (bucket) bucket.push(task)
    else byStatus.set(key, [task])
  }
  for (const bucket of byStatus.values()) bucket.sort(compareCards)

  const known = BOARD_COLUMNS.map((spec) => ({
    ...spec,
    tasks: byStatus.get(spec.key) ?? [],
  })).filter((col) => col.alwaysVisible || col.tasks.length > 0)

  const knownKeys = new Set(BOARD_COLUMNS.map((spec) => spec.key))
  const extras = [...byStatus.keys()]
    .filter((key) => !knownKeys.has(key))
    .sort()
    .map((key) => ({
      key,
      title: key,
      accent: "text-muted",
      alwaysVisible: false,
      tasks: byStatus.get(key) ?? [],
    }))

  return [...known, ...extras]
}

/** Total cards on the board (post-filter), for the header count. */
export function boardCardCount(columns: readonly BoardColumn[]): number {
  return columns.reduce((sum, col) => sum + col.tasks.length, 0)
}

/* ----- optimistic drag overrides (M2) ------------------------------------
 * A drop paints the card into its target column immediately; the daemon's
 * task.snapshot round-trip is the truth. taskId → expected status. */

export type StatusOverrides = Readonly<Record<string, string>>

/** Paint pending drops over the authoritative task list. */
export function applyStatusOverrides(
  tasks: Task[],
  overrides: StatusOverrides,
): Task[] {
  if (Object.keys(overrides).length === 0) return tasks
  return tasks.map((task) => {
    const status = overrides[task.id]
    return status && status !== task.status ? { ...task, status } : task
  })
}

/**
 * Drop overrides the snapshot has confirmed (task.status === expected) and
 * overrides whose task vanished (deleted/archived elsewhere). An UNRELATED
 * snapshot — some other task changed — must keep a pending override, or the
 * card bounces back mid-RPC (docs/design/web-kanban.md R4). Returns the SAME
 * reference when nothing changed so React can skip.
 */
export function reconcileOverrides(
  overrides: StatusOverrides,
  tasks: Task[],
): StatusOverrides {
  const entries = Object.entries(overrides)
  if (entries.length === 0) return overrides
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const next: Record<string, string> = {}
  let changed = false
  for (const [taskId, status] of entries) {
    const task = byId.get(taskId)
    if (!task || task.status === status) {
      changed = true
      continue
    }
    next[taskId] = status
  }
  return changed ? next : overrides
}

/** Only canonical lifecycle columns accept drops — a dynamic unknown-status
 *  column renders cards but is not a drag target. */
export function isDroppableColumn(key: string): boolean {
  return BOARD_COLUMNS.some((spec) => spec.key === key)
}
