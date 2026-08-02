/**
 * Sidebar tree state — the flat row list and the cursor's translation
 * between row ids and the terminal's (taskId, tabId) pair.
 *
 * Kept out of `Sidebar.tsx` for the file-size cap, and out of `tree-core.ts`
 * because that module is framework-free (vitest loads it in Node) while this
 * one is React state.
 *
 * There is NO fold anywhere (owner call 2026-08-01, round 5): every project
 * and every worktree always shows everything under it. The tree is a map,
 * not a filing cabinet — hiding rows just made the map lie.
 *
 * The tab projection reads through `knownTaskTabs`, which answers for tasks
 * whose TerminalTabs is not mounted — the whole point of the tree is that
 * you can see another worktree's tabs without switching to it first.
 */

import type { Task } from "@/types/task"
import { DEFAULT_TASK_VENDOR } from "@/types/task"
import { useCallback, useMemo } from "react"
import { sidebarProjectKey } from "../../../tui/panes/sidebar/groups"
import {
  type TreeRow,
  type TreeTab,
  buildTreeRows,
  filterTreeRows,
  mainTaskIdOfProject,
  parseRowId,
  tabRowId,
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
  /** Live `/` query. Non-empty prunes the tree to matches + their ancestors. */
  readonly query?: string
}

export interface TreeState {
  readonly rows: readonly TreeRow[]
  readonly flatIds: readonly string[]
  /** Navigable rows before the query pruned anything — the `N/total` suffix. */
  readonly totalCount: number
  /** How many tabs this worktree has — the menu needs the count to know
   *  whether closing one is possible. */
  readonly tabCount: (taskId: string) => number
  /** The row id the right pane is currently showing. */
  readonly activeRowId: string | null
  /** The project a task belongs to, or null for a project-less `dir` task. */
  readonly projectIdOfTask: (taskId: string) => string | null
  /** The task whose move reorders this project (its `main` checkout). */
  readonly mainTaskIdOfProject: (projectId: string) => string | null
}

export function useTreeState(opts: TreeStateOpts): TreeState {
  const { tasks, kv, selectedTaskId, selectedTabId } = opts
  const query = opts.query ?? ""
  const searching = query.trim() !== ""

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
          // The active tab carries the task's state glyph (activity is
          // task-scoped; the active tab is the session it describes).
          active: tab.id === known.activeId,
        })),
      )
    }
    return map
  }, [tasks, kv])

  const { rows, totalCount } = useMemo(() => {
    const all = buildTreeRows({ tasks, tabsByTask })
    const total = treeFlatIds(all).length
    return { rows: searching ? filterTreeRows(all, query) : all, totalCount: total }
  }, [tasks, tabsByTask, searching, query])
  const flatIds = useMemo(() => treeFlatIds(rows), [rows])

  // The active row is the selected task's ACTIVE TAB, else the worktree row
  // itself — the highlight lands on the deepest row that names the session.
  const activeRowId = useMemo(() => {
    if (selectedTaskId === null) return null
    if (selectedTabId !== null) return tabRowId(selectedTaskId, selectedTabId)
    return selectedTaskId
  }, [selectedTaskId, selectedTabId])

  const tabCount = useCallback((taskId: string): number => tabsByTask.get(taskId)?.length ?? 0, [tabsByTask])

  const mainTaskOfProject = useCallback(
    (projectId: string): string | null => mainTaskIdOfProject(tasks, projectId),
    [tasks],
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
    tabCount,
    activeRowId,
    projectIdOfTask,
    mainTaskIdOfProject: mainTaskOfProject,
  }
}

/** Re-exported so the Sidebar can translate a cursor row id without also
 *  importing the core module directly. */
export { parseRowId }
