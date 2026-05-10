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
 * Empty input returns an empty array. The caller (`Sidebar.tsx`)
 * handles the empty-state placeholder separately; we don't emit a
 * synthetic header for that.
 *
 * Pure: no Solid, no opentui. Component code calls this inside a memo;
 * tests call it directly.
 */
export function buildRows(tasks: readonly Task[], view: SidebarView): SidebarRow[] {
  const filtered = filterByView(tasks, view)
  const rows: SidebarRow[] = []
  for (let i = 0; i < filtered.length; i++) {
    const task = filtered[i]
    if (task) rows.push({ kind: "task", task, flatIndex: i })
  }
  return rows
}

/** Extract the flat list of navigable task ids. */
export function flattenIds(rows: readonly SidebarRow[]): string[] {
  return rows.map((r) => r.task.id)
}
