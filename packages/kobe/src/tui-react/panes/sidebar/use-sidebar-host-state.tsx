/**
 * Shared Sidebar-host state — the wiring both hosts that mount the shared
 * `Sidebar` (the tmux Tasks pane and the pure-TUI workspace) had
 * copy-pasted: the error/info toast helpers, the global sort pref
 * (kv-persisted, fanned out by the daemon's ui-prefs watcher), and the
 * move-mode toggle behind the sidebar's local-merge/move request.
 *
 * KNOWN DRIFT (deliberate, not hidden here): the Tasks pane FOLLOWS live
 * `ui-prefs` pushes for sortMode/projectFilter, the workspace host does
 * not. Those follow effects stay in the hosts, driving the raw
 * `setSortMode` returned here.
 */

import { useState } from "react"
import type { TaskSortMode } from "../../../tui/panes/sidebar/groups"
import type { Task } from "../../../types/task.ts"
import type { KVContext } from "../../context/kv"
import type { NotificationsContext } from "../../context/notifications"

export interface SidebarHostState {
  readonly sortMode: TaskSortMode
  /** Raw state setter (no kv write) — for hosts following ui-prefs pushes. */
  readonly setSortMode: (next: TaskSortMode) => void
  /**
   * Flip the sort: apply locally for instant feedback, then persist — the kv
   * write lands in state.json and the daemon's ui-prefs watcher fans it out
   * to every other session's Sidebar host (global sort).
   */
  readonly toggleSortMode: () => void
  readonly moveMode: boolean
  readonly setMoveMode: (next: boolean) => void
  /**
   * Surface a user-action FAILURE as a red error toast. Under an alternate
   * screen a bare `console.error` is invisible (it only reaches the daemon
   * log), so a failed key press would otherwise look like a silent no-op.
   * Call sites KEEP their matching `console.error` for log forensics — this
   * is the on-screen half. The notifications context is per-ChatTab
   * (taskId/tabId-keyed); a host action isn't tab-scoped, so it's tagged
   * with the selected task and an empty tab — only the toast queue is
   * consumed, the unread-dot map is harmless side state never rendered.
   */
  readonly notifyError: (message: string) => void
  /**
   * Neutral (non-error) toast — same on-screen surfacing as notifyError but
   * green/`done` styling, for "this happened" confirmations (engine cycled,
   * creating task, already up to date) that aren't failures.
   */
  readonly notifyInfo: (message: string) => void
  /**
   * The Sidebar's local-merge/move request (`m`): select the row and toggle
   * move mode. Works for regular tasks AND `main` (project) rows — projects
   * render stored order, so moving a main row reorders the PROJECTS section.
   */
  readonly onLocalMergeRequest: (id: string) => void
}

export function useSidebarHostState(args: {
  readonly kv: KVContext
  readonly notif: NotificationsContext
  readonly tasks: readonly Task[]
  readonly selectedId: string | null
  readonly setSelectedId: (id: string) => void
}): SidebarHostState {
  const { kv, notif, tasks, selectedId, setSelectedId } = args

  function notifyError(message: string): void {
    notif.notify({ kind: "error", taskId: selectedId ?? "", tabId: "", title: message })
  }
  function notifyInfo(message: string): void {
    notif.notify({ kind: "done", taskId: selectedId ?? "", tabId: "", title: message })
  }

  // Sort mode is a GLOBAL pref, fanned out like theme/appearance: the toggle
  // writes `activeSortMode` to state.json and the daemon's ui-prefs watcher
  // pushes it on the `ui-prefs` channel. Seed from the persisted value so a
  // freshly-spawned host opens in the user's last sort.
  const [sortMode, setSortMode] = useState<TaskSortMode>(kv.get("activeSortMode") === "recent" ? "recent" : "default")
  const toggleSortMode = (): void => {
    const next: TaskSortMode = sortMode === "default" ? "recent" : "default"
    setSortMode(next)
    kv.set("activeSortMode", next)
  }

  const [moveMode, setMoveMode] = useState(false)
  const onLocalMergeRequest = (id: string): void => {
    const task = tasks.find((t) => t.id === id)
    if (!task) return
    setSelectedId(id)
    setMoveMode((cur) => !cur)
  }

  return { sortMode, setSortMode, toggleSortMode, moveMode, setMoveMode, notifyError, notifyInfo, onLocalMergeRequest }
}
