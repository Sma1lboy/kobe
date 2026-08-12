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
import { useCallback, useEffect, useMemo, useState } from "react"
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
  withRecentRow,
} from "../../../tui/panes/sidebar/tree-core"
import { getDefaultLiveEngines } from "../../../tui/workspace/live-engine"
import { tabTitleStable } from "../../../tui/workspace/terminal-tab-split"
import { tabPtyKeyFor } from "../../../tui/workspace/terminal-tabs-core"
import type { TabsSnapshotKv } from "../../workspace/terminal-tabs-persist"
import { knownTaskTabs } from "../../workspace/terminal-tabs-shared"
import { orphanTabsByTask } from "./orphan-tabs"
import { useHostSessions } from "./use-host-sessions"

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
  /** Narrow mode's "↩ recent" jump target — prepended as the first navigable
   *  row. Hidden while a search query is open (you are hunting, not going
   *  back). Absent/null = no row. */
  readonly recentTask?: Task | null
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

  // Live process identity (the `ps`-walk store): a user-typed `claude` in a
  // shell tab IS an agent while that process lives, and stops being one the
  // moment it exits — the same rule the strip/turn-polls use. Subscribing
  // here is what re-renders the tree when a shell becomes an agent; the
  // store notifies only when some key's vendor actually MOVED.
  const liveEngines = getDefaultLiveEngines()
  const [liveTick, setLiveTick] = useState(0)
  useEffect(() => liveEngines.subscribe(() => setLiveTick((tick) => tick + 1)), [liveEngines])

  // Live pty-host inventory, for tasks the snapshot can't answer for.
  const hostSessions = useHostSessions()

  // Tab projection. `tasks` identity changes on every daemon snapshot echo,
  // which is also exactly when a tab's live title may have moved — so this
  // recomputing with it is correct, not wasteful.
  const tabsByTask = useMemo<ReadonlyMap<string, readonly TreeTab[]>>(() => {
    void liveTick
    const map = new Map<string, readonly TreeTab[]>()
    for (const task of tasks) {
      const known = knownTaskTabs(kv, task.id)
      if (!known) continue
      const vendor = task.vendor ?? DEFAULT_TASK_VENDOR
      map.set(
        task.id,
        known.tabs.map((tab) => {
          // Tri-state live identity: a vendor / "confirmed no engine" (null) /
          // "can't look" (undefined — no attached PTY, e.g. right after a TUI
          // restart). Only the can't-look case falls back to the RECORDED
          // `liveVendor` (itself tri-state — the persisted twin); a confirmed
          // engine-free shell must not resurrect the identity of whatever ran
          // there before (a ctrl+C'd codex kept its tab labelled "codex N"
          // through the old `?? recorded` fallback).
          const probed = liveEngines.resolve(tabPtyKeyFor(task.id, tab))
          const live = probed === undefined ? tab.liveVendor : probed
          return {
            id: tab.id,
            // `tabTitleStable`, NOT `tabTitle`: for a status-owning engine the
            // recorded title IS its self-reported status (`⠐ 利用自进化…`), and
            // the tree has no live stream to refresh it — so the row would
            // wear a frozen spinner phrase that contradicts the state glyph
            // right next to it, which kobe derives from daemon activity.
            label: tabTitleStable(tab, vendor, live),
            // The active tab carries the task's state glyph (activity is
            // task-scoped; the active tab is the session it describes).
            active: tab.id === known.activeId,
            // Agent = a kobe-launched engine tab, OR a tab whose live process
            // is an engine right now (user typed `claude` in a shell), OR one
            // whose RECORDED identity says so while the live probe can't
            // answer: hosted PTYs keep the process alive across TUI restarts,
            // but the fresh registry has nothing to walk until the tab
            // re-mounts, and demoting the row to a plain dot for that gap
            // reads as a lie.
            engine: tab.kind === "engine" || (live ?? null) !== null,
          }
        }),
      )
    }
    // Backstop: any LIVE pty session the snapshots don't answer for renders
    // as an explicit unregistered row — tab-granular, so a task whose
    // snapshot lists tab-2 while tab-1 is alive still shows tab-1 (issue
    // #20's invisible engine). A registered tab keeps its richer snapshot
    // projection. See `orphan-tabs.ts`.
    const registered = new Set<string>()
    for (const [taskId, tabs] of map) for (const tab of tabs) registered.add(tabRowId(taskId, tab.id))
    for (const [taskId, orphans] of orphanTabsByTask(hostSessions, registered)) {
      if (!tasks.some((t) => t.id === taskId)) continue
      const existing = map.get(taskId)
      // Appended under a task with snapshot tabs, an orphan is never the
      // active one — the snapshot's activeId owns that.
      map.set(taskId, existing ? [...existing, ...orphans.map((tab) => ({ ...tab, active: false }))] : orphans)
    }
    return map
  }, [tasks, kv, liveEngines, liveTick, hostSessions])

  const recentTask = opts.recentTask ?? null
  const { rows, totalCount } = useMemo(() => {
    const all = buildTreeRows({ tasks, tabsByTask })
    const total = treeFlatIds(all).length
    return { rows: searching ? filterTreeRows(all, query) : withRecentRow(all, recentTask), totalCount: total }
  }, [tasks, tabsByTask, searching, query, recentTask])
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
