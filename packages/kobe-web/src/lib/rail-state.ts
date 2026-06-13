/**
 * Task-rail filter state — module store (issue #7). The `/` route renders
 * <AppShell/> directly while /task/$taskId wraps it in <TaskRoute>, so the
 * first task-open from home unmounts+remounts AppShell and used to wipe the
 * rail's local useState (text query, status chip, sort, archived toggle) on
 * its most common trigger. Holding the state at module level (same pattern as
 * tabs.ts/toast.ts) makes it survive the remount.
 *
 * Persistence semantics (deliberate): in-memory ONLY — state survives route
 * navigation but resets on a full page reload. A text query or status filter
 * silently persisting across visits would be surprising; sortMode needs no
 * storage because the TUI's ui-prefs push re-seeds it each session.
 */

import { useSyncExternalStore } from "react"
import type { TaskSortMode } from "./task-list.ts"
import type { Bucket } from "./triage.ts"

export interface RailState {
  query: string
  statusFilter: Bucket | "all"
  sortMode: TaskSortMode
  showArchived: boolean
}

const initial: RailState = {
  query: "",
  statusFilter: "all",
  sortMode: "default",
  showArchived: false,
}

let state: RailState = initial
/** Last ui-prefs sortMode applied — lets applyPrefSort fire only on a CHANGED
 *  pref (rising edge), so an AppShell remount with the same pref no longer
 *  stomps a local sort toggle the way the old mount-effect reset did. */
let lastAppliedPrefSort: TaskSortMode | null = null
const listeners = new Set<() => void>()

function set(next: Partial<RailState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

export function setRailQuery(query: string): void {
  set({ query })
}

export function setRailStatusFilter(statusFilter: Bucket | "all"): void {
  set({ statusFilter })
}

export function setRailSortMode(sortMode: TaskSortMode): void {
  set({ sortMode })
}

export function setRailShowArchived(showArchived: boolean): void {
  set({ showArchived })
}

/** Sync the TUI's ui-prefs sort into the rail — only when the pref actually
 *  changed since the last application. A re-mount replaying the same pref is
 *  a no-op, so a local web-side toggle survives until the next real TUI push. */
export function applyPrefSort(prefSort: TaskSortMode | undefined): void {
  if (!prefSort || prefSort === lastAppliedPrefSort) return
  lastAppliedPrefSort = prefSort
  set({ sortMode: prefSort })
}

/** Test-only: restore the pristine module state between cases. */
export function resetRailState(): void {
  state = initial
  lastAppliedPrefSort = null
  for (const l of listeners) l()
}

/** Snapshot accessor (exported for tests; components use useRailState). */
export function getRailState(): RailState {
  return state
}

export function useRailState(): RailState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getRailState,
    getRailState,
  )
}
