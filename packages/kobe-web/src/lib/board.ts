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

import type { ConflictPair, Task } from "./types.ts"

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
  /** Cards beyond the terminal-column cap — rendered as a "+N more" note. */
  hiddenCount: number
}

/**
 * Terminal columns accrete forever (`done` ≠ `archived`), so only the most
 * recent slice renders; the rest is a count (R1 done-growth policy). Active
 * columns are never capped — hiding live work would be lying.
 */
export const TERMINAL_COLUMN_CAP = 30
const TERMINAL_KEYS = new Set(["done", "canceled", "error"])

/** Only worktree tasks flow across the board. */
export function isBoardTask(task: Task): boolean {
  return !task.archived && task.kind !== "main"
}

/** Spacing between renormalized position keys — wide enough that midpoint
 *  insertion practically never degenerates between renorms. */
export const POSITION_STEP = 1024

/**
 * Effective ordering key: the explicit `position` when set, else
 * newest-created-first (negative creation epoch). createdAt never changes,
 * so an un-dragged column is STABLE — unlike updatedAt ordering, which made
 * cards jump around while engines ran.
 */
export function effectivePosition(task: Task): number {
  if (typeof task.position === "number" && Number.isFinite(task.position)) {
    return task.position
  }
  const created = Date.parse(task.createdAt)
  return Number.isFinite(created) ? -created : 0
}

/** Within a column: pinned cards float, then ascending effective position
 *  (id as a stable tiebreak). */
export function compareCards(a: Task, b: Task): number {
  if ((a.pinned ?? false) !== (b.pinned ?? false)) return a.pinned ? -1 : 1
  const byPosition = effectivePosition(a) - effectivePosition(b)
  if (byPosition !== 0) return byPosition
  return b.id.localeCompare(a.id)
}

/**
 * Position for inserting between two rendered neighbors: the midpoint, a
 * STEP beyond an edge neighbor, or 0 into an empty column. Returns null when
 * float precision collapses the midpoint into a neighbor — the caller then
 * renormalizes the whole column ({@link renormalizedMoves}).
 */
export function positionBetween(
  prev: Task | undefined,
  next: Task | undefined,
): number | null {
  if (!prev && !next) return 0
  if (!prev && next) return effectivePosition(next) - POSITION_STEP
  if (prev && !next) return effectivePosition(prev) + POSITION_STEP
  if (!prev || !next) return 0
  const a = effectivePosition(prev)
  const b = effectivePosition(next)
  const mid = a + (b - a) / 2
  return mid > a && mid < b ? mid : null
}

/** Explicit spaced positions for a whole column in its final visual order —
 *  the degenerate-midpoint fallback, sent as ONE task.reorder batch. */
export function renormalizedMoves(
  finalOrder: readonly Task[],
): Array<{ taskId: string; position: number }> {
  return finalOrder.map((task, index) => ({
    taskId: task.id,
    position: (index + 1) * POSITION_STEP,
  }))
}

export type DropPlan =
  | { kind: "single"; position: number }
  | { kind: "renormalize"; moves: Array<{ taskId: string; position: number }> }

/**
 * Persistence plan for dropping `moving` into a column. The math runs over
 * the FULL column membership (uncapped, unfiltered — pass every task whose
 * displayed status is the target column, minus the moving card, in
 * compareCards order), never the rendered slice: positions computed against
 * visible-only neighbors would strand hidden cards (terminal-column cap,
 * active filter) on the wrong side of the drop.
 *
 * `visiblePrev`/`visibleNext` are the moving card's rendered neighbors at
 * the drop slot; they anchor the slot inside the full order. The insertion
 * index is clamped to the pinned prefix (compareCards floats pinned cards
 * regardless of position, so an unpinned card can never actually land above
 * a pinned one — persisting a position that pretends otherwise would
 * teleport it). The single-position candidate is then VALIDATED by
 * simulation: if sorting the column with the candidate doesn't land the
 * card in the intended slot (pin shuffles, midpoint degeneracy), the plan
 * falls back to renormalizing the whole column.
 */
export function planColumnDrop(opts: {
  fullColumn: readonly Task[]
  moving: Task
  visiblePrev?: Task
  visibleNext?: Task
}): DropPlan {
  const { fullColumn, moving, visiblePrev, visibleNext } = opts
  const nextIdx = visibleNext
    ? fullColumn.findIndex((t) => t.id === visibleNext.id)
    : -1
  const prevIdx = visiblePrev
    ? fullColumn.findIndex((t) => t.id === visiblePrev.id)
    : -1
  let insertAt = nextIdx >= 0 ? nextIdx : prevIdx >= 0 ? prevIdx + 1 : 0

  const pinnedCount = fullColumn.filter((t) => t.pinned).length
  insertAt = moving.pinned
    ? Math.min(insertAt, pinnedCount)
    : Math.max(insertAt, pinnedCount)

  const finalOrder = [
    ...fullColumn.slice(0, insertAt),
    moving,
    ...fullColumn.slice(insertAt),
  ]
  const candidate = positionBetween(
    fullColumn[insertAt - 1],
    fullColumn[insertAt],
  )
  if (candidate !== null) {
    const simulated = [...fullColumn, { ...moving, position: candidate }].sort(
      compareCards,
    )
    if (simulated.findIndex((t) => t.id === moving.id) === insertAt) {
      return { kind: "single", position: candidate }
    }
  }
  return { kind: "renormalize", moves: renormalizedMoves(finalOrder) }
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

  const capped = (
    key: string,
    tasks: Task[],
  ): { tasks: Task[]; hiddenCount: number } => {
    if (!TERMINAL_KEYS.has(key) || tasks.length <= TERMINAL_COLUMN_CAP) {
      return { tasks, hiddenCount: 0 }
    }
    return {
      tasks: tasks.slice(0, TERMINAL_COLUMN_CAP),
      hiddenCount: tasks.length - TERMINAL_COLUMN_CAP,
    }
  }

  const known = BOARD_COLUMNS.map((spec) => ({
    ...spec,
    ...capped(spec.key, byStatus.get(spec.key) ?? []),
  })).filter(
    (col) => col.alwaysVisible || col.tasks.length + col.hiddenCount > 0,
  )

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
      hiddenCount: 0,
    }))

  return [...known, ...extras]
}

/** Total cards on the board (post-filter), for the header count. */
export function boardCardCount(columns: readonly BoardColumn[]): number {
  return columns.reduce((sum, col) => sum + col.tasks.length, 0)
}

/* ----- optimistic drag overrides (M2 status, M3 position) ----------------
 * A drop paints the card into its target column/slot immediately; the
 * daemon's task.snapshot round-trip is the truth. taskId → expected fields. */

export interface BoardOverride {
  readonly status?: string
  readonly position?: number
}

export type BoardOverrides = Readonly<Record<string, BoardOverride>>

/** Paint pending drops over the authoritative task list. */
export function applyBoardOverrides(
  tasks: Task[],
  overrides: BoardOverrides,
): Task[] {
  if (Object.keys(overrides).length === 0) return tasks
  return tasks.map((task) => {
    const override = overrides[task.id]
    if (!override) return task
    const status = override.status ?? task.status
    const position = override.position ?? task.position
    if (status === task.status && position === task.position) return task
    return { ...task, status, position }
  })
}

/**
 * Drop override FIELDS the snapshot has confirmed (task.status / position
 * equals the expected value) and whole entries whose task vanished
 * (deleted/archived elsewhere). An UNRELATED snapshot — some other task
 * changed — must keep a pending override, or the card bounces back mid-RPC
 * (docs/design/web-kanban.md R4). Returns the SAME reference when nothing
 * changed so React can skip.
 */
export function reconcileOverrides(
  overrides: BoardOverrides,
  tasks: Task[],
): BoardOverrides {
  const entries = Object.entries(overrides)
  if (entries.length === 0) return overrides
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const next: Record<string, BoardOverride> = {}
  let changed = false
  for (const [taskId, override] of entries) {
    const task = byId.get(taskId)
    if (!task) {
      changed = true
      continue
    }
    const keep: { status?: string; position?: number } = {}
    if (override.status !== undefined && task.status !== override.status) {
      keep.status = override.status
    }
    if (
      override.position !== undefined &&
      task.position !== override.position
    ) {
      keep.position = override.position
    }
    if (keep.status === undefined && keep.position === undefined) {
      changed = true
      continue
    }
    if (
      keep.status !== override.status ||
      keep.position !== override.position
    ) {
      changed = true
    }
    next[taskId] = keep
  }
  return changed ? next : overrides
}

/** Only canonical lifecycle columns accept drops — a dynamic unknown-status
 *  column renders cards but is not a drag target. */
export function isDroppableColumn(key: string): boolean {
  return BOARD_COLUMNS.some((spec) => spec.key === key)
}

/* ----- conflict radar (docs/design/conflict-radar.md) -------------------- */

/** The radar pairs touching one task. */
export function conflictsForTask(
  pairs: readonly ConflictPair[],
  taskId: string,
): ConflictPair[] {
  return pairs.filter((pair) => pair.a === taskId || pair.b === taskId)
}

/** Card badge summary: the strongest level + how many counterparts. */
export function conflictBadge(
  pairs: readonly ConflictPair[],
  taskId: string,
): { level: "overlap" | "conflict"; count: number } | null {
  const mine = conflictsForTask(pairs, taskId)
  if (mine.length === 0) return null
  return {
    level: mine.some((pair) => pair.level === "conflict")
      ? "conflict"
      : "overlap",
    count: mine.length,
  }
}

/** Yarn palette — one distinct kobe hue per conflict pair, cycling. The
 *  pair's index in the (sorted, stable) pair list picks the color, so a
 *  pair keeps its yarn color as long as the pair exists. */
export const YARN_COLORS: readonly string[] = [
  "var(--color-kobe-orange)",
  "var(--color-kobe-blue)",
  "var(--color-kobe-violet)",
  "var(--color-kobe-yellow)",
  "var(--color-kobe-green)",
  "var(--color-kobe-red)",
]

export function yarnColor(index: number): string {
  return YARN_COLORS[index % YARN_COLORS.length] as string
}
