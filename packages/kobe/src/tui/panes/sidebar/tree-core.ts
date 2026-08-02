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
import { fuzzyMatch } from "./fuzzy"
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
  /** The task's ACTIVE tab — the row that carries the session's state glyph
   *  (owner call 2026-08-01: state lives on the chattab, not the worktree). */
  readonly active?: boolean
  /** A coding-agent tab. Shell/command/content tabs are outside the state
   *  vocabulary entirely — they always wear the plain dot. */
  readonly engine?: boolean
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

export interface TreeInput {
  readonly tasks: readonly Task[]
  /** Tabs per task id. A task absent from the map contributes no tab rows —
   *  its tabs have never mounted, which is not the same as having none. */
  readonly tabsByTask: ReadonlyMap<string, readonly TreeTab[]>
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
 * `dir` tasks (`kobe .` on an arbitrary directory) group under THEIR
 * DIRECTORY as the project header (owner 2026-08-02) — their `repo` IS the
 * directory, so the grouping rule is the same one every task uses. Emitting
 * them loose after the last project made them read as that project's rows.
 */
export function buildTreeRows(input: TreeInput): TreeRow[] {
  const { tasks, tabsByTask } = input
  const byProject = new Map<string, { repo: string; tasks: Task[] }>()

  for (const task of tasks) {
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
    for (const task of entry.tasks) pushWorktree(rows, task, tabsByTask)
  }
  return rows
}

function pushWorktree(rows: TreeRow[], task: Task, tabsByTask: ReadonlyMap<string, readonly TreeTab[]>): void {
  rows.push({ kind: "worktree", id: task.id, task, depth: 1 })
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

/** The project a row belongs to. A `dir` task's project is its directory —
 *  the same key `buildTreeRows` groups it under. */
function ownerProjectKey(task: Task): string | null {
  return sidebarProjectKey(task.repo)
}

/** What a row's text is matched against. */
function rowHaystack(row: TreeRow): string {
  if (row.kind === "project") return row.label
  if (row.kind === "tab") return row.tab.label
  return `${row.task.title} ${row.task.branch ?? ""} ${repoBasename(row.task.repo)}`
}

/**
 * Prune the tree to what matches `query`, keeping every hit's ANCESTORS so a
 * match never floats free of the worktree and project it lives in.
 *
 * Match semantics per kind, chosen so one query answers all three questions
 * the tree can be asked:
 *   - project  → repo basename. A hit keeps the WHOLE subtree ("show me
 *     everything in kobe").
 *   - worktree → title + branch + repo basename: the flat sidebar's haystack
 *     plus the branch the tree actually labels the row with. A hit keeps the
 *     worktree's tabs ("that branch, and what's running in it").
 *   - tab      → the tab's label, i.e. its live OSC window title. This is the
 *     tree's own increment over the flat sidebar, which can only search task
 *     titles: it answers "which tab is running that thing".
 */
export function filterTreeRows(rows: readonly TreeRow[], query: string): TreeRow[] {
  const q = query.trim()
  if (q === "") return [...rows]

  // Pass 1 — rows matching on their own text, plus the ancestors each hit
  // keeps alive.
  const selfMatch = new Set<string>()
  const keep = new Set<string>()
  for (const row of rows) {
    if (!fuzzyMatch(q, rowHaystack(row))) continue
    selfMatch.add(row.id)
    keep.add(row.id)
    if (row.kind === "project") continue
    if (row.kind === "tab") keep.add(row.task.id)
    const project = ownerProjectKey(row.task)
    if (project !== null) keep.add(project)
  }

  // Pass 2 — emit a row when it matched, when a descendant kept it, or when
  // an ancestor matched outright (a project hit brings its subtree along).
  const out: TreeRow[] = []
  for (const row of rows) {
    if (row.kind === "project") {
      if (keep.has(row.id)) out.push(row)
      continue
    }
    const project = ownerProjectKey(row.task)
    const underMatchedProject = project !== null && selfMatch.has(project)
    if (row.kind === "worktree") {
      if (underMatchedProject || keep.has(row.id)) out.push(row)
      continue
    }
    if (underMatchedProject || selfMatch.has(row.task.id) || keep.has(row.id)) out.push(row)
  }
  return out
}

/**
 * Every project key, in the same first-seen order `buildTreeRows` emits its
 * project headers — what "focus one project" needs in order to know which
 * others to fold.
 */
export function projectKeysOf(tasks: readonly Task[]): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const task of tasks) {
    const key = ownerProjectKey(task)
    if (key === null || seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return keys
}

/**
 * The `main` task of a project — the repo's own checkout.
 *
 * This is how the tree REORDERS projects, and it needs no new persistence:
 * a project's position is where its first task appears in the store, and
 * `moveTask` on a `main` row already swaps it past the neighbouring project's
 * `main` (mains move among mains). So moving the main task IS moving the
 * project, and one existing daemon call covers it.
 *
 * Null when the project has no main checkout — a repo that only ever produced
 * task worktrees has no row to move, so project reorder is a no-op there.
 */
export function mainTaskIdOfProject(tasks: readonly Task[], projectKey: string): string | null {
  for (const task of tasks) {
    if (task.kind !== "main") continue
    if (sidebarProjectKey(task.repo) === projectKey) return String(task.id)
  }
  return null
}
