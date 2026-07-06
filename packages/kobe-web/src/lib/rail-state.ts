import { createExternalStore } from "./external-store.ts"
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

const store = createExternalStore(initial)
let lastAppliedPrefSort: TaskSortMode | null = null

function set(next: Partial<RailState>): void {
  store.update((state) => ({ ...state, ...next }))
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

export function applyPrefSort(prefSort: TaskSortMode | undefined): void {
  if (!prefSort || prefSort === lastAppliedPrefSort) return
  lastAppliedPrefSort = prefSort
  set({ sortMode: prefSort })
}

export function resetRailState(): void {
  lastAppliedPrefSort = null
  store.replace(initial)
}

export function getRailState(): RailState {
  return store.getSnapshot()
}

export function useRailState(): RailState {
  return store.useSnapshot()
}
