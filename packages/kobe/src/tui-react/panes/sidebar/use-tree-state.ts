/**
 * Sidebar tree state — expansion, the flat row list, and the cursor's
 * translation between row ids and the terminal's (taskId, tabId) pair.
 *
 * Kept out of `Sidebar.tsx` for the file-size cap, and out of `tree-core.ts`
 * because that module is framework-free (vitest loads it in Node) while this
 * one is React state.
 *
 * The tab projection reads through `knownTaskTabs`, which answers for tasks
 * whose TerminalTabs is not mounted — the whole point of the tree is that
 * you can see another worktree's tabs without switching to it first.
 */

import type { Task } from "@/types/task"
import { DEFAULT_TASK_VENDOR } from "@/types/task"
import { useCallback, useMemo, useState } from "react"
import { sidebarProjectKey } from "../../../tui/panes/sidebar/groups"
import {
  type TreeRow,
  type TreeTab,
  buildTreeRows,
  filterTreeRows,
  focusProjectSet,
  isProjectFocused,
  parseRowId,
  projectKeysOf,
  tabRowId,
  toggleInSet,
  treeFlatIds,
} from "../../../tui/panes/sidebar/tree-core"
import { tabTitle } from "../../../tui/workspace/terminal-tab-split"
import type { TabsSnapshotKv } from "../../workspace/terminal-tabs-persist"
import { knownTaskTabs } from "../../workspace/terminal-tabs-shared"

export interface TreeStateOpts {
  readonly tasks: readonly Task[]
  /** Null when no KV provider is mounted — see `knownTaskTabs`. */
  readonly kv: TabsSnapshotKv | null
  /** The task whose session the right pane is showing. */
  readonly selectedTaskId: string | null
  /** That task's active tab, so the tree can mark the exact live row. */
  readonly selectedTabId: string | null
  /** Tasks whose engine is mid-turn — drives the tab row's busy dot. */
  readonly busyTaskIds?: ReadonlySet<string>
  /** Live `/` query. Non-empty prunes the tree to matches + their ancestors. */
  readonly query?: string
}

export interface TreeState {
  readonly rows: readonly TreeRow[]
  readonly flatIds: readonly string[]
  /** Navigable rows before the query pruned anything — the `N/total` suffix. */
  readonly totalCount: number
  /** Whether this worktree has tabs AT ALL — asked by the disclosure glyph,
   *  which must keep pointing at hidden children while collapsed (the rows
   *  themselves are gone in that state, so counting rows would flicker the
   *  twisty away the moment you closed it). */
  readonly hasTabs: (taskId: string) => boolean
  /** The row id the right pane is currently showing. */
  readonly activeRowId: string | null
  readonly expandedWorktrees: ReadonlySet<string>
  readonly collapsedProjects: ReadonlySet<string>
  readonly toggleWorktree: (taskId: string) => void
  readonly toggleProject: (projectId: string) => void
  /** Fold every project but this one (and unfold on a second press). */
  readonly focusProject: (projectId: string) => void
  /** This project is currently the only open one. */
  readonly isProjectFocused: (projectId: string) => boolean
  /** The project a task belongs to, or null for a project-less `dir` task. */
  readonly projectIdOfTask: (taskId: string) => string | null
}

/** Shared empty set — searching builds rows with nothing collapsed, and a
 *  fresh `new Set()` each render would break the row memo. */
const NOTHING_COLLAPSED: ReadonlySet<string> = new Set<string>()

export function useTreeState(opts: TreeStateOpts): TreeState {
  const { tasks, kv, selectedTaskId, selectedTabId, busyTaskIds } = opts
  const query = opts.query ?? ""
  const searching = query.trim() !== ""
  // Everything expanded by DEFAULT (owner call 2026-08-01, round 4) — the
  // sets hold only what the user collapsed by hand, so a new worktree or a
  // freshly-mounted tab list shows up without a keystroke.
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(() => new Set<string>())

  // Tab projection. `tasks` identity changes on every daemon snapshot echo,
  // which is also exactly when a tab's live title may have moved — so this
  // recomputing with it is correct, not wasteful.
  const tabsByTask = useMemo<ReadonlyMap<string, readonly TreeTab[]>>(() => {
    const map = new Map<string, readonly TreeTab[]>()
    for (const task of tasks) {
      const known = knownTaskTabs(kv, task.id)
      if (!known) continue
      const vendor = task.vendor ?? DEFAULT_TASK_VENDOR
      map.set(
        task.id,
        known.tabs.map((tab) => ({
          id: tab.id,
          // No live name here: the tree renders tabs it does not host, so
          // `tabTitle` falls back to the tab's last recorded title — the
          // same path the Inbox takes.
          label: tabTitle(tab, vendor),
          busy: busyTaskIds?.has(task.id) === true && tab.id === known.activeId,
        })),
      )
    }
    return map
  }, [tasks, kv, busyTaskIds])

  // Searching IGNORES hand-collapsed state: a hit folded out of sight reads
  // as "no results", so the query builds against the fully-open tree and the
  // pruner puts back only what matched (plus its ancestors).
  const { rows, totalCount } = useMemo(() => {
    const all = buildTreeRows({
      tasks,
      tabsByTask,
      collapsedWorktrees: searching ? NOTHING_COLLAPSED : collapsedWorktrees,
      collapsedProjects: searching ? NOTHING_COLLAPSED : collapsedProjects,
    })
    const total = treeFlatIds(all).length
    return { rows: searching ? filterTreeRows(all, query) : all, totalCount: total }
  }, [tasks, tabsByTask, collapsedWorktrees, collapsedProjects, searching, query])
  const flatIds = useMemo(() => treeFlatIds(rows), [rows])

  // The expanded set is what the RENDERER asks about (twisty state), so keep
  // that vocabulary at the boundary: expanded = not hand-collapsed.
  const expandedWorktrees = useMemo(() => {
    const set = new Set<string>()
    for (const task of tasks) if (!collapsedWorktrees.has(task.id)) set.add(task.id)
    return set
  }, [tasks, collapsedWorktrees])

  // The active row is the selected task's ACTIVE TAB when that worktree is
  // expanded, else the worktree row itself — so the highlight lands on the
  // deepest row that is actually visible rather than disappearing when the
  // user collapses the worktree they are working in.
  const activeRowId = useMemo(() => {
    if (selectedTaskId === null) return null
    if (selectedTabId !== null && !collapsedWorktrees.has(selectedTaskId)) {
      return tabRowId(selectedTaskId, selectedTabId)
    }
    return selectedTaskId
  }, [selectedTaskId, selectedTabId, collapsedWorktrees])

  const hasTabs = useCallback((taskId: string): boolean => (tabsByTask.get(taskId)?.length ?? 0) > 0, [tabsByTask])

  const toggleWorktree = useCallback((taskId: string) => {
    setCollapsedWorktrees((prev) => toggleInSet(prev, taskId))
  }, [])
  const toggleProject = useCallback((projectId: string) => {
    setCollapsedProjects((prev) => toggleInSet(prev, projectId))
  }, [])

  // Project keys come from the TASKS, not the rendered rows: a pruned search
  // result may be missing the very projects focus needs to fold.
  const projectIds = useMemo(() => projectKeysOf(tasks), [tasks])
  const focusProject = useCallback(
    (projectId: string) => {
      setCollapsedProjects((prev) => focusProjectSet(projectIds, projectId, prev))
    },
    [projectIds],
  )
  const projectFocused = useCallback(
    (projectId: string): boolean => isProjectFocused(projectIds, projectId, collapsedProjects),
    [projectIds, collapsedProjects],
  )
  const projectIdOfTask = useCallback(
    (taskId: string): string | null => {
      const task = tasks.find((candidate) => candidate.id === taskId)
      if (!task || task.kind === "dir") return null
      return sidebarProjectKey(task.repo)
    },
    [tasks],
  )

  return {
    rows,
    flatIds,
    totalCount,
    hasTabs,
    activeRowId,
    expandedWorktrees,
    collapsedProjects,
    toggleWorktree,
    toggleProject,
    focusProject,
    isProjectFocused: projectFocused,
    projectIdOfTask,
  }
}

/** Re-exported so the Sidebar can translate a cursor row id without also
 *  importing the core module directly. */
export { parseRowId }
