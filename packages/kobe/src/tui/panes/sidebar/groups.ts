/**
 * Pure list-shaping helpers for the sidebar pane.
 *
 * Wave 4.5 dropped repo grouping (Jackson decided "撤销 repo分组也太蠢了").
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
 * No grouping = no headers in the row list. {@link buildRows} returns a
 * filtered, ordered task list with each row's `flatIndex` so the
 * renderer can compare cursor positions without recounting.
 *
 * No reactivity here: pure functions over `readonly Task[]`. The Solid
 * component (`Sidebar.tsx`) wraps these in `createMemo` so they recompute
 * only when the upstream task signal or view changes.
 */

import type { Task } from "@/types/task"

/**
 * Which sidebar view is active. Rendered as a tab strip at the top of
 * the pane; switched with `[` (left) and `]` (right).
 */
export type SidebarView = "active" | "archived"

/**
 * One visible row in the sidebar body. Wave 4.5 collapsed the row union
 * to just `task` — repo headers were dropped. The shape is preserved as
 * a discriminated union so future row types (e.g. a "loading…"
 * placeholder, separator) can be added without rewriting the renderer.
 */
export type SidebarRow = { kind: "task"; task: Task; flatIndex: number }

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
 *   1. Pinned "main" tasks first, ordered by repo basename (KOB-15).
 *   2. User-pinned regular tasks (`pinned === true`), in input order.
 *   3. Other regular tasks (`kind === "task"`), in input order.
 *
 * Archived view: same structure (main rows the user archived float to
 * the top of the archives list), still ordered by repo basename.
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
export function buildRows(tasks: readonly Task[], view: SidebarView): SidebarRow[] {
  const filtered = filterByView(tasks, view)
  const main: Task[] = []
  const pinnedRegular: Task[] = []
  const regular: Task[] = []
  for (const t of filtered) {
    if (t.kind === "main") main.push(t)
    else if (t.pinned === true) pinnedRegular.push(t)
    else regular.push(t)
  }
  // Pinned section is alphabetised by repo basename so two repos with
  // the same prefix sit predictably (kobe < kobe-fork). Regular tasks
  // keep their orchestrator-supplied order.
  main.sort((a, b) => repoBasename(a.repo).localeCompare(repoBasename(b.repo)))
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

/** Extract the flat list of navigable task ids. */
export function flattenIds(rows: readonly SidebarRow[]): string[] {
  return rows.map((r) => r.task.id)
}
