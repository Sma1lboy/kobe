/**
 * Kanban board logic — pure column math shared out of the Board view so
 * bucketing, ordering, and visibility are unit-testable (the activity.ts /
 * triage.ts precedent).
 *
 * Columns bind to the PERSISTED `Task.status` lifecycle, never the transient
 * engine activity — activity is a per-card signal lamp, not a drop target
 * (docs/design/web-kanban.md). Archived tasks and `kind: "main"` project rows
 * are not workflow cards, so they never enter the board.
 */

import type { Issue, Task } from "./types.ts"

/**
 * One card on the unified board. A task card flows across the status columns
 * (its bucket is the persisted `Task.status`); an issue card always sits in
 * Backlog, carrying its source `repo` so project-grouping can key it. The two
 * stores stay separate — the board just renders them side by side and dedups
 * a linked pair down to the task card.
 */
export type BoardCard =
  | ({ kind: "task" } & Task)
  | { kind: "issue"; repo: string; issue: Issue }

/**
 * Discriminate on the ISSUE side, not `kind === "task"`: a task card's `kind`
 * comes from `Task.kind` ("main" | "task"), so a defensively-passed main row
 * would slip past a `=== "task"` check. Everything that isn't an issue card is
 * a task card (then filtered by {@link isBoardTask}).
 */
export function isIssueCard(
  card: BoardCard,
): card is Extract<BoardCard, { kind: "issue" }> {
  return card.kind === "issue"
}
export function isTaskCard(
  card: BoardCard,
): card is Extract<BoardCard, { kind: "task" }> {
  return card.kind !== "issue"
}

/** A card's repo: `task.repo` for a task card, the explicit `repo` for an
 *  issue card — both shapes expose `.repo`, so this is just a typed accessor. */
export function cardRepo(card: BoardCard): string {
  return card.repo
}

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
  cards: BoardCard[]
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
 *  (id as a stable tiebreak). Tasks-only — the drag math reorders tasks. */
export function compareCards(a: Task, b: Task): number {
  if ((a.pinned ?? false) !== (b.pinned ?? false)) return a.pinned ? -1 : 1
  const byPosition = effectivePosition(a) - effectivePosition(b)
  if (byPosition !== 0) return byPosition
  return b.id.localeCompare(a.id)
}

/**
 * Backlog is the only mixed column (tasks + their repo's unstarted issues).
 * Task cards float to the top in their usual compareCards order (live work
 * outranks an idea), then issue cards sort newest-created first, id desc as
 * the day-granular tiebreak (the groupByStatus precedent). Two cards of the
 * same kind delegate to their kind's comparator; cross-kind, tasks win.
 */
export function compareBacklogCards(a: BoardCard, b: BoardCard): number {
  const aIssue = isIssueCard(a)
  const bIssue = isIssueCard(b)
  if (aIssue !== bIssue) return aIssue ? 1 : -1 // tasks float above issues
  if (!aIssue && !bIssue) return compareCards(a, b)
  if (aIssue && bIssue) {
    if (a.issue.created !== b.issue.created) {
      return a.issue.created < b.issue.created ? 1 : -1
    }
    return b.issue.id - a.issue.id
  }
  return 0
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
 * Bucket cards into render-ready columns. Task cards bucket by their persisted
 * `Task.status` (a status outside the canonical enum becomes a trailing
 * dynamic column titled by the raw key — a newer daemon must never drop a
 * card); issue cards ALWAYS sit in Backlog. Backlog mixes both kinds and
 * sorts with {@link compareBacklogCards}; every other column is tasks-only
 * and sorts with {@link compareCards}.
 */
export function buildBoard(cards: BoardCard[]): BoardColumn[] {
  const byStatus = new Map<string, BoardCard[]>()
  const push = (key: string, card: BoardCard): void => {
    const bucket = byStatus.get(key)
    if (bucket) bucket.push(card)
    else byStatus.set(key, [card])
  }
  for (const card of cards) {
    if (isIssueCard(card)) {
      push("backlog", card)
    } else {
      if (!isBoardTask(card)) continue
      push(card.status || "backlog", card)
    }
  }
  for (const [key, bucket] of byStatus) {
    bucket.sort(key === "backlog" ? compareBacklogCards : compareTaskCards)
  }

  const capped = (
    key: string,
    bucket: BoardCard[],
  ): { cards: BoardCard[]; hiddenCount: number } => {
    if (!TERMINAL_KEYS.has(key) || bucket.length <= TERMINAL_COLUMN_CAP) {
      return { cards: bucket, hiddenCount: 0 }
    }
    return {
      cards: bucket.slice(0, TERMINAL_COLUMN_CAP),
      hiddenCount: bucket.length - TERMINAL_COLUMN_CAP,
    }
  }

  const known = BOARD_COLUMNS.map((spec) => ({
    ...spec,
    ...capped(spec.key, byStatus.get(spec.key) ?? []),
  })).filter(
    (col) => col.alwaysVisible || col.cards.length + col.hiddenCount > 0,
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
      cards: byStatus.get(key) ?? [],
      hiddenCount: 0,
    }))

  return [...known, ...extras]
}

/** compareCards over BoardCard for the tasks-only columns — issue cards never
 *  reach a non-Backlog column, so a defensive task-first order is enough. */
function compareTaskCards(a: BoardCard, b: BoardCard): number {
  if (!isIssueCard(a) && !isIssueCard(b)) return compareCards(a, b)
  if (isIssueCard(a) !== isIssueCard(b)) return isIssueCard(a) ? 1 : -1
  return 0
}

/** Total cards on the board (post-filter), for the header count. */
export function boardCardCount(columns: readonly BoardColumn[]): number {
  return columns.reduce((sum, col) => sum + col.cards.length, 0)
}

/* ----- unified board: dedup + per-project partition ----------------------- */

/** A task is "live" — it actively represents its linked issue, so the issue
 *  hides behind it — while it isn't archived and hasn't reached a terminal
 *  status (done/canceled/error). A deleted/archived/finished task lets its
 *  issue resurface in Backlog. */
const DEAD_TASK_STATUSES = new Set(["done", "canceled", "error"])
export function isLiveTask(task: Task): boolean {
  return !task.archived && !DEAD_TASK_STATUSES.has(task.status)
}

/**
 * Set of task ids that are currently LIVE. The link is now one-way
 * (`Issue.taskId` → a task; a task no longer reverse-references its issue), so
 * dedup keys on the task id, not a `${repo}:${issueId}` pair. Built from the
 * FULL, unfiltered task list — a task hidden in the rendered slice (project
 * filter, terminal-column cap) must still suppress its issue, so reading the
 * rendered cards would resurface a duplicate. `kind: "main"` rows are skipped
 * the same way the board skips them everywhere else.
 */
export function liveTaskIds(tasks: readonly Task[]): Set<string> {
  const ids = new Set<string>()
  for (const task of tasks) {
    if (task.kind === "main") continue
    if (!isLiveTask(task)) continue
    ids.add(task.id)
  }
  return ids
}

/** One project's board: its repo key, display label, and rendered columns. */
export interface ProjectBoard {
  readonly repo: string
  readonly label: string
  readonly columns: BoardColumn[]
}

/**
 * Partition every card into one board per project (= git repo), deriving the
 * project list from the UNION of issue-repos and task-repos so a project with
 * only issues (no task yet) still appears, and vice versa. An issue whose
 * `issue.taskId` points to a LIVE task is dropped here (the task card
 * represents it) — deduped against the FULL task list passed in `allTasks`,
 * not just the cards the caller chose to render. Projects are sorted by label
 * so they don't reorder as counts shift.
 */
export function buildProjectBoards(
  cards: readonly BoardCard[],
  allTasks: readonly Task[],
): ProjectBoard[] {
  const live = liveTaskIds(allTasks)
  const byRepo = new Map<string, BoardCard[]>()
  for (const card of cards) {
    if (isIssueCard(card)) {
      // Linked to a live task → represented by that task card instead.
      const { taskId } = card.issue
      if (taskId !== undefined && live.has(taskId)) continue
    } else if (!isBoardTask(card)) {
      continue
    }
    const repo = card.repo
    const bucket = byRepo.get(repo)
    if (bucket) bucket.push(card)
    else byRepo.set(repo, [card])
  }
  const repos = [...byRepo.keys()]
  return repos
    .map((repo) => ({
      repo,
      label: labelRepo(repo, repos),
      columns: buildBoard(byRepo.get(repo) ?? []),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
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

/**
 * Droppable id for a column in a project's board: `${repo}:${columnKey}`.
 * The unified board renders one column set per project, so a bare column key
 * would collide across projects (two "in_review" drop targets) — the repo
 * prefix keeps each project's columns distinct.
 */
export function droppableId(repo: string, columnKey: string): string {
  return `${repo}:${columnKey}`
}

/**
 * Split a composite droppable id back into its `{ repo, columnKey }`. The
 * column key is the segment after the LAST colon (repos can contain colons —
 * `ssh://host/...`), so we split from the right.
 */
export function parseDroppableId(
  id: string,
): { repo: string; columnKey: string } | null {
  const idx = id.lastIndexOf(":")
  if (idx <= 0 || idx === id.length - 1) return null
  return { repo: id.slice(0, idx), columnKey: id.slice(idx + 1) }
}

/** Only canonical lifecycle columns accept drops — a dynamic unknown-status
 *  column renders cards but is not a drag target. Accepts either a bare
 *  column key or a composite `${repo}:${columnKey}` droppable id. */
export function isDroppableColumn(key: string): boolean {
  const columnKey = parseDroppableId(key)?.columnKey ?? key
  return BOARD_COLUMNS.some((spec) => spec.key === columnKey)
}

/* ----- project (repo) filter --------------------------------------------- */

export interface RepoOption {
  /** Full repo key (local path or remote key) — the filter value. */
  readonly repo: string
  /** Short display name: path basename, parent/basename on collision. */
  readonly label: string
  /** Board cards (non-archived, non-main) currently in this repo. */
  readonly count: number
}

function repoBasename(repo: string): string {
  const trimmed = repo.replace(/\/+$/, "")
  return trimmed.split("/").pop() || trimmed
}

/**
 * Short display name for a repo within a known set: the path basename, or
 * `parent/basename` when two repos in the set share a basename. Shared by the
 * Board's project chips and the issue repo options (was duplicated in both —
 * board.ts + issues.ts). `repos` is the disambiguation universe.
 */
export function labelRepo(repo: string, repos: readonly string[]): string {
  const base = repoBasename(repo)
  const collides = repos.some((r) => r !== repo && repoBasename(r) === base)
  if (!collides) return base
  return repo.replace(/\/+$/, "").split("/").slice(-2).join("/")
}

/**
 * Distinct projects among the board's cards, for the filter-chip row.
 * Labels are path basenames; two repos sharing a basename are
 * disambiguated to `parent/basename`. Sorted by label so chips don't
 * reorder as card counts shift.
 */
export function repoOptions(tasks: readonly Task[]): RepoOption[] {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    if (!isBoardTask(task)) continue
    counts.set(task.repo, (counts.get(task.repo) ?? 0) + 1)
  }
  const repos = [...counts.keys()]
  return repos
    .map((repo) => ({
      repo,
      label: labelRepo(repo, repos),
      count: counts.get(repo) ?? 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}
