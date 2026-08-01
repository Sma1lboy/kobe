/**
 * Sidebar tree shaping — project → worktree → tab, as ONE flat row list.
 *
 * The owner's call (2026-08-01) retires the horizontal chattab strip: a
 * worktree's tabs become child rows under it in the sidebar, and the right
 * side is nothing but the active terminal. This module owns the shape; the
 * renderer owns the glyphs.
 *
 * Why flat rows with a `depth` instead of a nested structure: the entire
 * sidebar navigation model is a cursor over `flatTaskIds` (see
 * `controller.ts`) — j/k/gg/search/ctrl+digit all index into that one array.
 * Emitting tab rows into the SAME array means every one of those behaviours
 * extends to tabs for free, and a tab row is selectable by exactly the
 * mechanism that already selects tasks. A tree of nested arrays would have
 * required a parallel traversal for each.
 *
 * The row id is the navigation key, so it must be unique across both kinds:
 * a task row keys on the task id, a tab row on `${taskId}::${tabId}` — the
 * same composite the PTY registry already uses for tab keys, so the two
 * never disagree about what identifies a tab.
 */

import type { Task } from "@/types/task"
import { repoBasename, sidebarProjectKey } from "./groups"

/** Separator between a task id and a tab id in a tab row's id. Matches the
 *  PTY registry's key format so one parse rule covers both. */
export const TAB_ROW_SEPARATOR = "::"

/** A worktree row's tab, as the sidebar needs it (the tab module owns the
 *  real shape; this is the projection the tree renders). */
export interface TreeTab {
  readonly id: string
  /** Already-resolved display name — title ?? liveName ?? … ?? "Tab N".
   *  Resolving precedence is the tab module's job, not the tree's. */
  readonly label: string
  /** The tab's engine is mid-turn / waiting — drives the row's dot. */
  readonly busy?: boolean
}

export type TreeRow =
  | { readonly kind: "project"; readonly id: string; readonly repo: string; readonly label: string; readonly depth: 0 }
  | { readonly kind: "worktree"; readonly id: string; readonly task: Task; readonly depth: 1 }
  | {
      readonly kind: "tab"
      readonly id: string
      readonly task: Task
      readonly tab: TreeTab
      readonly depth: 2
    }

/** Compose a tab row's navigation id. */
export function tabRowId(taskId: string, tabId: string): string {
  return `${taskId}${TAB_ROW_SEPARATOR}${tabId}`
}

/**
 * Split a row id back into its parts. A task row id has no separator and
 * yields `tabId: null` — callers switch on that rather than string-matching
 * the separator themselves.
 *
 * Task ids are ULIDs and tab ids are `tab-N`, so neither contains the
 * separator; splitting on the FIRST occurrence is unambiguous either way.
 */
export function parseRowId(rowId: string): { taskId: string; tabId: string | null } {
  const at = rowId.indexOf(TAB_ROW_SEPARATOR)
  if (at < 0) return { taskId: rowId, tabId: null }
  return { taskId: rowId.slice(0, at), tabId: rowId.slice(at + TAB_ROW_SEPARATOR.length) }
}

/** Which worktree rows are expanded, by task id. */
export type ExpandedSet = ReadonlySet<string>

export interface TreeInput {
  readonly tasks: readonly Task[]
  /** Tabs per task id. A task absent from the map contributes no tab rows —
   *  its tabs have never mounted, which is not the same as having none. */
  readonly tabsByTask: ReadonlyMap<string, readonly TreeTab[]>
  readonly expandedWorktrees: ExpandedSet
  readonly collapsedProjects: ExpandedSet
}

/**
 * Build the flat tree rows.
 *
 * Ordering: projects in their stored order (same rule the flat sidebar used
 * — tasks.json order is save order, so a new repo lands at the end and the
 * list never reshuffles on its own), each followed by its own worktrees, each
 * followed by its own tabs.
 *
 * A `main` task IS the project's main worktree, so it renders as the first
 * worktree row under its project rather than as the project row itself: the
 * project row is a pure grouping header (a repo, not a checkout), which is
 * what lets "main" carry tabs like any other worktree.
 *
 * `dir` tasks have no project association by construction (`kobe .` on an
 * arbitrary directory), so they are emitted as depth-1 rows with no project
 * header — hiding them under a synthetic project would claim a relationship
 * that does not exist.
 */
export function buildTreeRows(input: TreeInput): TreeRow[] {
  const { tasks, tabsByTask, expandedWorktrees, collapsedProjects } = input
  const byProject = new Map<string, { repo: string; tasks: Task[] }>()
  const looseTasks: Task[] = []

  for (const task of tasks) {
    if (task.kind === "dir") {
      looseTasks.push(task)
      continue
    }
    const key = sidebarProjectKey(task.repo)
    const entry = byProject.get(key) ?? { repo: task.repo, tasks: [] }
    // The main task carries the canonical repo path — a regular task's
    // `repo` is the same value, but taking it from main keeps the header
    // label stable if they ever disagree.
    if (task.kind === "main") {
      entry.repo = task.repo
      entry.tasks.unshift(task)
    } else {
      entry.tasks.push(task)
    }
    byProject.set(key, entry)
  }

  const rows: TreeRow[] = []
  for (const [key, entry] of byProject) {
    rows.push({ kind: "project", id: key, repo: entry.repo, label: repoBasename(entry.repo), depth: 0 })
    if (collapsedProjects.has(key)) continue
    for (const task of entry.tasks) pushWorktree(rows, task, tabsByTask, expandedWorktrees)
  }
  for (const task of looseTasks) pushWorktree(rows, task, tabsByTask, expandedWorktrees)
  return rows
}

function pushWorktree(
  rows: TreeRow[],
  task: Task,
  tabsByTask: ReadonlyMap<string, readonly TreeTab[]>,
  expanded: ExpandedSet,
): void {
  rows.push({ kind: "worktree", id: task.id, task, depth: 1 })
  if (!expanded.has(task.id)) return
  for (const tab of tabsByTask.get(task.id) ?? []) {
    rows.push({ kind: "tab", id: tabRowId(task.id, tab.id), task, tab, depth: 2 })
  }
}

/**
 * The navigable id list — what the cursor indexes into.
 *
 * Project rows are EXCLUDED: they are grouping headers, and letting the
 * cursor rest on one would mean `enter` has no session to open and every
 * per-task chord (d/a/r) would need a "not on a header" guard. Collapsing a
 * project is a mouse click or a chord from one of its worktrees, not a
 * cursor position.
 */
export function treeFlatIds(rows: readonly TreeRow[]): string[] {
  const ids: string[] = []
  for (const row of rows) {
    if (row.kind !== "project") ids.push(row.id)
  }
  return ids
}

/**
 * Toggle membership in an expanded/collapsed set, returning a NEW set.
 *
 * Returning a fresh set (rather than mutating) is what lets React see the
 * change: the sets are held in state, and an in-place `add` would leave the
 * identity unchanged and skip the re-render.
 */
export function toggleInSet(set: ExpandedSet, id: string): Set<string> {
  const next = new Set(set)
  if (!next.delete(id)) next.add(id)
  return next
}

/**
 * Which worktrees should start expanded: the selected one, so the tabs of
 * the session you are looking at are visible without a keystroke. Everything
 * else starts collapsed — a dozen worktrees each showing their tabs is the
 * wall of rows this design exists to avoid.
 */
export function initialExpanded(selectedTaskId: string | null): Set<string> {
  return selectedTaskId === null ? new Set() : new Set([selectedTaskId])
}
