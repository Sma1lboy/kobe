/**
 * Pure list-shaping helpers for the sidebar pane.
 *
 * Wave 4.5 dropped repo grouping.
 * The sidebar is now a flat list of task rows split into two views:
 *
 *   - "Working session" (active) — `task.archived === false`
 *   - "Archives"                  — `task.archived === true`
 *
 * The user toggles between views with `[` / `]` and toggles the archived
 * flag on the cursor task with `a`. Repo / branch / worktree metadata
 * for the SELECTED task is shown in the topbar instead — see
 * `src/tui/component/topbar.tsx`.
 *
 * No grouping = no per-project headers in the row list. {@link buildRows}
 * returns a filtered, ordered task list with each row's `flatIndex` so the
 * renderer can compare cursor positions without recounting.
 *
 * The renderer (`Sidebar.tsx`) draws this single ordered list as TWO flat
 * sections: the `main` (repo-root) rows come first — rendered as a compact
 * PROJECTS list — then a divider, then every non-main row as the flat TASKS
 * list. This is NOT per-project grouping: a task is not nested under its
 * repo, it just lives in the one shared tasks section. Because `buildRows`
 * already emits all `main` rows before any task row, the renderer only needs
 * the index of the first non-main row to place the divider.
 *
 * No reactivity here: pure functions over `readonly Task[]`. The Solid
 * component (`Sidebar.tsx`) wraps these in `createMemo` so they recompute
 * only when the upstream task signal or view changes.
 */

import { reconcileStableRows } from "@/tui/lib/stable-rows"
import type { Task } from "@/types/task"
import { fuzzyMatch } from "./fuzzy"

/**
 * Which sidebar view is active. Rendered as a tab strip at the top of
 * the pane; switched with `[` (left) and `]` (right).
 */
export type SidebarView = "active" | "archived"
export type TaskSortMode = "default" | "recent"

/**
 * One visible row in the sidebar body. Wave 4.5 collapsed the row union
 * to just `task` — repo headers were dropped. The shape is preserved as
 * a discriminated union so future row types (e.g. a "loading…"
 * placeholder, separator) can be added without rewriting the renderer.
 */
export type SidebarRow = { kind: "task"; task: Task; flatIndex: number }
export type SidebarProjectOption = { repo: string; label: string; count: number }
export type SidebarRowSections = {
  projectRows: SidebarRow[]
  taskRows: SidebarRow[]
}

/**
 * Filter tasks by the active view. Active view (= "Working session")
 * shows `archived: false` rows; archived view shows the rest. The input
 * order is preserved within each view — the orchestrator owns ordering.
 */
export function filterByView(tasks: readonly Task[], view: SidebarView): Task[] {
  const wantArchived = view === "archived"
  return tasks.filter((t) => t.archived === wantArchived)
}

/**
 * Build the flat row list for rendering, filtered by view. Each task row
 * carries its `flatIndex` — its position in the navigable id list — so
 * the renderer can compare against the cursor without recounting.
 *
 * Row order in the active ("Working session") view:
 *   1. Pinned "main" tasks first, ordered by repo basename.
 *   2. User-pinned regular tasks (`pinned === true`), in input order.
 *   3. Other regular tasks (`kind === "task"`), in input order.
 *
 * Archived view: same structure (main rows the user archived float to
 * the top of the archives list), still ordered by repo basename.
 *
 * `searchQuery` — optional case-insensitive subsequence filter applied
 * after view filtering, before grouping. Haystack per task is
 * `title + " " + basename(repo)`. Empty / undefined query is a no-op.
 * Search preserves the main → pinned → regular ordering so users
 * filtering inside a long list still see the same predictable shape.
 *
 * `projectFilter` narrows only regular task rows. Main project rows stay in
 * their separate PROJECTS section so the filter does not recreate repo
 * grouping; it just scopes the flat TASKS section.
 *
 * Why two passes rather than a single sort: the regular-task ordering
 * is owned by the orchestrator (createdAt-derived ULID order), and
 * sorting both groups together would scramble it. A stable partition
 * preserves the regular tasks' original order.
 *
 * Empty input returns an empty array. The caller (`Sidebar.tsx`)
 * handles the empty-state placeholder separately; we don't emit a
 * synthetic header for that.
 *
 * Pure: no Solid, no opentui. Component code calls this inside a memo;
 * tests call it directly.
 */
export function buildRows(
  tasks: readonly Task[],
  view: SidebarView,
  searchQuery?: string,
  sortMode: TaskSortMode = "default",
  projectFilter?: string | null,
): SidebarRow[] {
  const filteredByView = filterByView(tasks, view)
  const q = searchQuery?.trim() ?? ""
  const projectKey = projectFilter ? sidebarProjectKey(projectFilter) : null
  const filtered = q
    ? filteredByView.filter((t) => fuzzyMatch(q, `${t.title} ${repoBasename(t.repo)}`))
    : filteredByView
  const main: Task[] = []
  const pinnedRegular: Task[] = []
  const regular: Task[] = []
  const seenMainRepos = new Set<string>()
  for (const t of filtered) {
    if (t.kind === "main") {
      const key = sidebarProjectKey(t.repo)
      if (seenMainRepos.has(key)) continue
      seenMainRepos.add(key)
      main.push(t)
      continue
    }
    if (projectKey && sidebarProjectKey(t.repo) !== projectKey) continue
    if (t.pinned === true) pinnedRegular.push(t)
    else regular.push(t)
  }
  // Projects keep their STORED order (owner 2026-07-16): tasks.json order =
  // save order, so a newly-added repo lands at the end and the list never
  // reshuffles on its own. Manual reordering goes through move mode
  // (`moveTask` covers main rows within the projects partition). `recent`
  // sort still only affects the task groups — projects sit tight.
  if (sortMode === "recent") {
    pinnedRegular.sort(compareRecent)
    regular.sort(compareRecent)
  }
  const rows: SidebarRow[] = []
  let flatIndex = 0
  for (const task of main) {
    rows.push({ kind: "task", task, flatIndex })
    flatIndex++
  }
  for (const task of pinnedRegular) {
    rows.push({ kind: "task", task, flatIndex })
    flatIndex++
  }
  for (const task of regular) {
    rows.push({ kind: "task", task, flatIndex })
    flatIndex++
  }
  return rows
}

function compareRecent(a: Task, b: Task): number {
  const byTime = taskTime(b) - taskTime(a)
  if (byTime !== 0) return byTime
  return String(b.id).localeCompare(String(a.id))
}

function taskTime(task: Task): number {
  const parsed = Date.parse(task.updatedAt || task.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Repo basename. Strips a trailing slash before taking the last
 * segment so `/Users/x/kobe/` and `/Users/x/kobe` land on the same
 * label. Empty input yields an empty string.
 *
 * Exported for the Sidebar's row renderer — main tasks display this
 * as the title (instead of `task.title`, which is a stored copy that
 * could drift if the user renamed the directory). Pure / no Solid.
 */
export function repoBasename(repo: string): string {
  const segments = repo.split("/").filter(Boolean)
  return segments[segments.length - 1] ?? repo
}

export function sidebarProjectKey(repo: string): string {
  const trimmed = repo.trim().replace(/[\\/]+$/, "")
  return trimmed || repo
}

export function sidebarProjectLabel(repo: string, repos: readonly string[]): string {
  const base = repoBasename(repo)
  const collides = repos.some((r) => r !== repo && repoBasename(r) === base)
  if (!collides) return base
  return repo
    .replace(/[\\/]+$/, "")
    .split(/[\\/]+/)
    .slice(-2)
    .join("/")
}

export function buildProjectOptions(tasks: readonly Task[], view: SidebarView): SidebarProjectOption[] {
  const wantArchived = view === "archived"
  const byKey = new Map<string, { repo: string; count: number }>()
  for (const task of tasks) {
    const key = sidebarProjectKey(task.repo)
    const next = byKey.get(key) ?? { repo: task.repo, count: 0 }
    if (task.kind === "main") {
      next.repo = task.repo
    } else if (task.archived === wantArchived) {
      next.count += 1
    }
    byKey.set(key, next)
  }
  const repos = [...byKey.values()].map((entry) => entry.repo)
  // Stored order — matches the sidebar's PROJECTS section (no re-sort).
  return [...byKey.values()].map((entry) => ({
    repo: entry.repo,
    label: sidebarProjectLabel(entry.repo, repos),
    count: entry.count,
  }))
}

export function cursorIndexForProjectScope(rows: readonly SidebarRow[], projectFilter?: string | null): number {
  if (rows.length === 0) return -1
  if (!projectFilter) return rows[0]?.flatIndex ?? -1
  const projectKey = sidebarProjectKey(projectFilter)
  const firstTask = rows.find((row) => row.task.kind !== "main" && sidebarProjectKey(row.task.repo) === projectKey)
  if (firstTask) return firstTask.flatIndex
  const projectRow = rows.find((row) => row.task.kind === "main" && sidebarProjectKey(row.task.repo) === projectKey)
  return projectRow?.flatIndex ?? rows[0]?.flatIndex ?? -1
}

/** Extract the flat list of navigable task ids. */
export function flattenIds(rows: readonly SidebarRow[]): string[] {
  return rows.map((r) => r.task.id)
}

/**
 * Where the cursor should sit after the external selection or the flat id list
 * changed — the single owner of the "follow selection / clamp into range" policy
 * the Sidebar's sync effect used to inline. Returns the TARGET index (may equal
 * `cursor`, i.e. leave it put). Pure, so the edge cases that kept biting —
 * selection cleared, selected task vanished from another surface and the list
 * shrank, cursor left dangling past a shortened list — are unit-tested instead
 * of hand-traced. `cursor` is the current index (-1 when unset).
 *
 *  - `selectedId === null`: keep the cursor in place; snap an unset cursor (-1)
 *    to the first row, and clamp an out-of-range cursor down to the last row.
 *    (Empty list: -1 only when the cursor was already unset — a stray cursor >= 0
 *    resolves to 0 here, which the view-switch reset then corrects.)
 *  - selected row present: follow it.
 *  - selected row absent: leave the cursor put if still in range, else clamp to
 *    the last row (or -1 on an empty list).
 */
export function resolveCursorTarget(selectedId: string | null, flatIds: readonly string[], cursor: number): number {
  const len = flatIds.length
  if (selectedId === null) {
    if (cursor === -1 && len > 0) return 0
    if (cursor >= len) return Math.max(0, len - 1)
    if (len === 0) return -1
    return cursor
  }
  const idx = flatIds.indexOf(selectedId)
  if (idx >= 0) return idx
  if (len === 0) return -1
  if (cursor < 0 || cursor >= len) return len - 1
  return cursor
}

/**
 * Split the already-ordered flat row list into the two rendered sections.
 *
 * The flat list remains the keyboard-navigation source of truth; this helper
 * is only a render partition so PROJECTS and TASKS can own independent
 * scrollboxes without changing cursor indexes or row identity.
 */
export function splitSidebarRows(rows: readonly SidebarRow[]): SidebarRowSections {
  const projectRows: SidebarRow[] = []
  const taskRows: SidebarRow[] = []
  for (const row of rows) {
    if (row.task.kind === "main") projectRows.push(row)
    else taskRows.push(row)
  }
  return { projectRows, taskRows }
}

/**
 * Field-level equality over exactly the Task fields the sidebar row
 * renderer dereferences from its captured `row.task` (Sidebar.tsx reads
 * the task NON-reactively inside the `<For>` callback, so a reused row
 * object freezes these fields until identity breaks).
 *
 * Deliberately excludes `createdAt` / `updatedAt` / `prStatus`: none are
 * rendered by a row, and `updatedAt` is bumped by every
 * `setActiveTask` recency touch — comparing it would re-key (destroy +
 * recreate) the switched-to row on every task switch for no visual
 * change. They still participate upstream: `buildRows` consumes
 * `updatedAt` for `recent` ordering BEFORE reconciliation, and a real
 * order change breaks reuse via `flatIndex`.
 *
 * If the row renderer starts reading a new Task field, add it here —
 * otherwise the row will render stale data after that field changes.
 */
export function sameSidebarRowTask(a: Task, b: Task): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.kind === b.kind &&
      a.title === b.title &&
      a.repo === b.repo &&
      a.branch === b.branch &&
      a.worktreePath === b.worktreePath &&
      a.status === b.status &&
      a.archived === b.archived &&
      a.pinned === b.pinned &&
      a.vendor === b.vendor)
  )
}

/**
 * Reconcile a freshly built sidebar row list against the previous one,
 * preserving object identity for rows whose rendered fields are
 * unchanged (docs/DESIGN.md §5.5 — the long-lived-pane rule).
 *
 * Why: every daemon `task.snapshot` push deserializes ALL-new Task
 * objects, so `buildRows` produces all-new `SidebarRow` wrappers even
 * when nothing the row renders changed (the common case: a
 * `setActiveTask` recency touch echoing back). Solid's `<For>` keys by
 * object identity, so without reconciliation each push destroyed and
 * recreated every row's opentui renderables — and @opentui/core 0.2.4
 * retains ~300B of native memory per renderable create/destroy cycle.
 * A Tasks pane lives for days in every tmux session; task switches
 * happen constantly; multiply and that's unbounded native growth
 * (same class as the Ops-pane filetree leak, `filetree/rows.ts`).
 *
 * Contract (mirrors `reconcileRows` in filetree):
 * - A `next` row whose task id exists in `prev` at the SAME flatIndex
 *   with {@link sameSidebarRowTask}-equal task fields → the PREV row
 *   object is returned in its place (so `<For>` reuses renderables).
 *   flatIndex must match because the renderer captures it non-reactively
 *   too (cursor compare + section-header placement).
 * - When every position resolves to its previous object, the `prev`
 *   ARRAY itself is returned, so a memo holding the result keeps its
 *   value identity and notifies nobody downstream.
 */
export function reconcileSidebarRows(prev: readonly SidebarRow[], next: readonly SidebarRow[]): readonly SidebarRow[] {
  return reconcileStableRows(
    prev,
    next,
    (row) => row.task.id,
    (a, b) => a.flatIndex === b.flatIndex && sameSidebarRowTask(a.task, b.task),
    { samePosition: true },
  )
}
