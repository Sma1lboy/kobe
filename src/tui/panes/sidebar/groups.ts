/**
 * Pure grouping function for the sidebar pane.
 *
 * Tasks live in the {@link TaskIndex} as a flat ordered array. The sidebar
 * displays them grouped by **repo** — Wave 4 direction shift, see HANDOFF.md
 * §"Direction shift" #1 + #2. Top-level rows are repo headers (with the
 * count of sessions belonging to that repo); nested rows are session rows
 * carrying the task and its current status (rendered as a per-row badge,
 * but no longer used for grouping).
 *
 * Layout shape:
 *
 *   my-frontend (3)
 *     ● fix login redirect bug
 *     ○ refactor auth service
 *     ○ add password reset
 *
 *   api-server (1)
 *     ● migrate to fastify
 *
 *   + Add repo
 *
 * **Why drop status grouping?** kobe doesn't manage PR-merge state — the
 * 5-group `In progress / In review / Backlog / Done / Canceled / Error`
 * shape was inherited from Conductor and didn't fit. `TaskStatus` stays
 * on disk untouched (concurrency cap depends on it; future experimental
 * flag will resurrect the UI), but the default sidebar groups by repo.
 *
 * **Repo display name**: we use `path.basename(repo)` — `/Users/jacksonc/i/foo`
 * becomes `foo`. The full path is still the grouping key (so two repos
 * with the same basename in different parents stay distinct) but the
 * label is shortened for the 42-cell sidebar width.
 *
 * **Repo ordering**: first-seen wins. We iterate tasks in their input
 * order and add a new repo group the first time we encounter it. The
 * orchestrator's task ordering (typically by `createdAt` ULID) therefore
 * drives repo ordering — the newest task's repo sits closest to the
 * top of the list when the orchestrator prepends. (If the orchestrator
 * appends instead, repos appear in creation order, which still feels
 * stable to the user.)
 *
 * **Within a group**: tasks keep their input order. The orchestrator
 * owns task ordering; we do not re-sort inside a repo.
 *
 * No reactivity here: this is a pure function over `readonly Task[]`. The
 * Solid component (`Sidebar.tsx`) wraps it in a `createMemo` so the
 * grouping recomputes only when the upstream task signal changes.
 */

import { basename } from "node:path"
import type { Task } from "@/types"

/**
 * One visible row in the sidebar body. Either a repo-group header
 * (with the count of tasks in that repo) or a navigable task row that
 * carries its position in the flat-id list (`flatIndex`).
 *
 * Repo headers carry both `repo` (the absolute path — the grouping key)
 * and `label` (the basename, used for display). Tests can assert on the
 * label without computing basenames themselves.
 */
export type SidebarRow =
  | { kind: "repo-header"; repo: string; label: string; count: number }
  | { kind: "task"; task: Task; flatIndex: number }

/**
 * Group a flat task list by repo path.
 *
 * Returns a `Map` (preserves insertion order — first-seen wins) so the
 * caller can iterate repos in a predictable sequence. The map's keys
 * are the absolute repo paths (`Task.repo`); the values are arrays of
 * tasks in input order.
 *
 * Mutation: returns fresh arrays. The input `tasks` is not mutated and
 * the returned arrays do not alias the input.
 */
export function groupByRepo(tasks: readonly Task[]): Map<string, Task[]> {
  const out = new Map<string, Task[]>()
  for (const t of tasks) {
    const bucket = out.get(t.repo)
    if (bucket) {
      bucket.push(t)
    } else {
      out.set(t.repo, [t])
    }
  }
  return out
}

/**
 * Compute a display label for a repo path. Uses {@link basename} so
 * `/Users/jacksonc/i/foo` becomes `foo`. Falls back to the full path
 * when the basename is empty (e.g. a path ending in `/`) — defensive
 * against unusual `Task.repo` values without crashing the renderer.
 */
export function repoLabel(repo: string): string {
  const b = basename(repo)
  return b.length > 0 ? b : repo
}

/**
 * Build the flat row list for rendering. Repo headers are interleaved
 * with task rows in first-seen repo order. Tasks within a repo keep
 * their input order. Each task row carries its `flatIndex` — its
 * position in the navigable id list — so the renderer can compare
 * against the cursor without recounting headers.
 *
 * Empty input returns an empty array. The caller (`Sidebar.tsx`)
 * handles the empty-state placeholder ("No tasks yet.") separately;
 * we don't emit a synthetic header for that.
 *
 * Pure: no Solid, no opentui. Component code calls this inside a memo;
 * tests call it directly.
 */
export function buildRows(tasks: readonly Task[]): SidebarRow[] {
  const groups = groupByRepo(tasks)
  const rows: SidebarRow[] = []
  let flat = 0
  for (const [repo, bucket] of groups) {
    rows.push({ kind: "repo-header", repo, label: repoLabel(repo), count: bucket.length })
    for (const t of bucket) {
      rows.push({ kind: "task", task: t, flatIndex: flat })
      flat++
    }
  }
  return rows
}

/** Extract the flat list of navigable task ids (header rows skipped). */
export function flattenIds(rows: readonly SidebarRow[]): string[] {
  const ids: string[] = []
  for (const r of rows) if (r.kind === "task") ids.push(r.task.id)
  return ids
}
