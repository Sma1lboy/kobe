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
import {
  type TreeRow,
  type TreeTab,
  buildTreeRows,
  initialExpanded,
  parseRowId,
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
}

export interface TreeState {
  readonly rows: readonly TreeRow[]
  readonly flatIds: readonly string[]
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
  /** Expand a worktree without collapsing it if already open — what
   *  selecting a task should do (selection reveals, it does not toggle). */
  readonly revealWorktree: (taskId: string) => void
}

export function useTreeState(opts: TreeStateOpts): TreeState {
  const { tasks, kv, selectedTaskId, selectedTabId, busyTaskIds } = opts
  const [expandedWorktrees, setExpandedWorktrees] = useState<ReadonlySet<string>>(() => initialExpanded(selectedTaskId))
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

  const rows = useMemo(
    () => buildTreeRows({ tasks, tabsByTask, expandedWorktrees, collapsedProjects }),
    [tasks, tabsByTask, expandedWorktrees, collapsedProjects],
  )
  const flatIds = useMemo(() => treeFlatIds(rows), [rows])

  // The active row is the selected task's ACTIVE TAB when that worktree is
  // expanded, else the worktree row itself — so the highlight lands on the
  // deepest row that is actually visible rather than disappearing when the
  // user collapses the worktree they are working in.
  const activeRowId = useMemo(() => {
    if (selectedTaskId === null) return null
    if (selectedTabId !== null && expandedWorktrees.has(selectedTaskId)) {
      return tabRowId(selectedTaskId, selectedTabId)
    }
    return selectedTaskId
  }, [selectedTaskId, selectedTabId, expandedWorktrees])

  const hasTabs = useCallback((taskId: string): boolean => (tabsByTask.get(taskId)?.length ?? 0) > 0, [tabsByTask])

  const toggleWorktree = useCallback((taskId: string) => {
    setExpandedWorktrees((prev) => toggleInSet(prev, taskId))
  }, [])
  const toggleProject = useCallback((projectId: string) => {
    setCollapsedProjects((prev) => toggleInSet(prev, projectId))
  }, [])
  const revealWorktree = useCallback((taskId: string) => {
    setExpandedWorktrees((prev) => (prev.has(taskId) ? prev : new Set(prev).add(taskId)))
  }, [])

  return {
    rows,
    flatIds,
    hasTabs,
    activeRowId,
    expandedWorktrees,
    collapsedProjects,
    toggleWorktree,
    toggleProject,
    revealWorktree,
  }
}

/** Re-exported so the Sidebar can translate a cursor row id without also
 *  importing the core module directly. */
export { parseRowId }
