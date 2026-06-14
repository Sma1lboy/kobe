/**
 * Kanban board logic — pure column math shared out of the Board view so
 * bucketing, ordering, and visibility are unit-testable (the activity.ts /
 * triage.ts precedent).
 *
 * The board is ISSUES-ONLY. Columns bind to the ISSUE's own lifecycle, never
 * task status or live engine activity — there are no task cards on the board.
 * Each issue lands in exactly one column by {@link issueColumnKey}:
 *   - Done       — the issue is `done`.
 *   - In progress — the issue is linked to a task (`taskId` set, i.e. started).
 *   - Backlog    — everything else (open / hold / unlinked).
 * A linked issue keeps a back-link to its task (a "started — open task"
 * affordance) but the task itself is NOT a card here (docs/design/web-kanban.md).
 */

import type { Issue } from "./types.ts"

/**
 * One card on the board: always an issue, carrying its source `repo` so
 * project-grouping can key it. (The board used to be a unified task+issue
 * board; tasks were dropped — the lag came from per-card live engine/worktree
 * subscriptions, and tasks still live in the Workspace view.)
 */
export interface BoardCard {
  repo: string
  issue: Issue
}

/** A card's repo — typed accessor (kept for call-site symmetry). */
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

/**
 * Canonical column order, by ISSUE lifecycle. A three-column board — the issue
 * has no in-review / error / canceled states (those were task-status columns),
 * so the resting board is just Backlog → In progress → Done.
 */
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
    key: "done",
    title: "Done",
    accent: "text-kobe-green",
    alwaysVisible: true,
  },
]

export interface BoardColumn extends BoardColumnSpec {
  cards: BoardCard[]
  /** Cards beyond the terminal-column cap — rendered as a "+N more" note. */
  hiddenCount: number
}

/**
 * The Done column accretes forever, so only the most recent slice renders; the
 * rest is a count (R1 done-growth policy). Active columns are never capped.
 */
export const TERMINAL_COLUMN_CAP = 30
const TERMINAL_KEYS = new Set(["done"])

/**
 * The column an issue lives in, by its own lifecycle (NOT task status):
 *   - `done`            → Done.
 *   - linked (`taskId`) → In progress (the issue was started).
 *   - otherwise         → Backlog (open / hold / unlinked).
 * Done wins over a stale link: a finished issue stays in Done even if it still
 * carries a `taskId`.
 */
export function issueColumnKey(issue: Issue): string {
  if (issue.status === "done") return "done"
  if (issue.taskId !== undefined && issue.taskId !== "") return "in_progress"
  return "backlog"
}

/** True when an issue is linked to a task — drives the "open task" affordance. */
export function isLinkedIssue(issue: Issue): boolean {
  return issue.taskId !== undefined && issue.taskId !== ""
}

/**
 * Within a column: newest-created first, then id desc as the day-granular
 * tiebreak (`created` is day-granular — the groupByStatus precedent).
 */
export function compareCards(a: BoardCard, b: BoardCard): number {
  if (a.issue.created !== b.issue.created) {
    return a.issue.created < b.issue.created ? 1 : -1
  }
  return b.issue.id - a.issue.id
}

/**
 * Bucket issue cards into render-ready columns by {@link issueColumnKey}. Every
 * column sorts with {@link compareCards}; the Done column is capped (R1).
 */
export function buildBoard(cards: BoardCard[]): BoardColumn[] {
  const byKey = new Map<string, BoardCard[]>()
  const push = (key: string, card: BoardCard): void => {
    const bucket = byKey.get(key)
    if (bucket) bucket.push(card)
    else byKey.set(key, [card])
  }
  for (const card of cards) {
    push(issueColumnKey(card.issue), card)
  }
  for (const bucket of byKey.values()) bucket.sort(compareCards)

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

  return BOARD_COLUMNS.map((spec) => ({
    ...spec,
    ...capped(spec.key, byKey.get(spec.key) ?? []),
  })).filter(
    (col) => col.alwaysVisible || col.cards.length + col.hiddenCount > 0,
  )
}

/** Total cards on the board (post-filter), for the header count. */
export function boardCardCount(columns: readonly BoardColumn[]): number {
  return columns.reduce((sum, col) => sum + col.cards.length, 0)
}

/* ----- per-project partition ---------------------------------------------- */

/** One project's board: its repo key, display label, and rendered columns. */
export interface ProjectBoard {
  readonly repo: string
  readonly label: string
  readonly columns: BoardColumn[]
}

/**
 * Partition every issue card into one board per project (= git repo). The
 * project list is the distinct set of issue-repos; an issue ALWAYS shows (no
 * task-card dedup any more — tasks aren't on the board). Projects are sorted by
 * label so they don't reorder as counts shift.
 */
export function buildProjectBoards(
  cards: readonly BoardCard[],
): ProjectBoard[] {
  const byRepo = new Map<string, BoardCard[]>()
  for (const card of cards) {
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

/* ----- repo labeling ------------------------------------------------------ */

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
