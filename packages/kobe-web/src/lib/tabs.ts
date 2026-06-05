/**
 * Tab + selection state, persisted in localStorage.
 *
 * Two levels: the workspace shows ONE selected TASK, and each task has its
 * OWN list of workspace tabs. Chat tabs are independent engine renders (their
 * own PTYs). File tabs are lightweight previews opened from the right Changes
 * rail. The whole list is purely client-owned and persisted here.
 */

import { useSyncExternalStore } from "react"

const KEY = "kobe-web.tabs"

export type WorkspaceTabKind = "empty" | "vendor" | "terminal" | "file"

export interface EmptyTab {
  id: string
  kind: "empty"
  title: string
}

export interface VendorTab {
  id: string
  kind: "vendor"
  title: string
}

export interface TerminalTab {
  id: string
  kind: "terminal"
  title: string
}

export interface FilePreviewTab {
  id: string
  kind: "file"
  title: string
  path: string
}

export type WorkspaceTab = EmptyTab | VendorTab | TerminalTab | FilePreviewTab

export interface TabsState {
  selectedTaskId: string | null
  /** taskId → its workspace tabs, in order. */
  tabsByTask: Record<string, WorkspaceTab[]>
  /** taskId → active tab id. */
  activeByTask: Record<string, string>
  /** taskId → horizontally split tab id shown on the right side. */
  splitByTask: Record<string, string>
}

const EMPTY: TabsState = {
  selectedTaskId: null,
  tabsByTask: {},
  activeByTask: {},
  splitByTask: {},
}

function emptyTab(): EmptyTab {
  return { id: newId(), kind: "empty", title: "New tab" }
}

function withTaskTab(next: TabsState, taskId: string): TabsState {
  const list = next.tabsByTask[taskId] ?? []
  const active = next.activeByTask[taskId]
  const split = next.splitByTask[taskId]
  let normalized = next
  if (split && (!list.some((tab) => tab.id === split) || split === active)) {
    const { [taskId]: _removed, ...rest } = next.splitByTask
    normalized = { ...next, splitByTask: rest }
  }
  if (list.length > 0) {
    if (active && list.some((tab) => tab.id === active)) return normalized
    return {
      ...normalized,
      activeByTask: { ...next.activeByTask, [taskId]: list[0].id },
    }
  }
  const tab = emptyTab()
  return {
    ...normalized,
    tabsByTask: { ...next.tabsByTask, [taskId]: [tab] },
    activeByTask: { ...next.activeByTask, [taskId]: tab.id },
  }
}

function load(): TabsState {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<TabsState>
      const tabsByTask = Object.fromEntries(
        Object.entries(p.tabsByTask ?? {}).map(([taskId, tabs]) => [
          taskId,
          tabs.map((tab) => {
            const stored = tab as Partial<WorkspaceTab> & { kind?: string }
            const kind =
              stored.kind === "chat" ? "vendor" : (stored.kind ?? "vendor")
            if (kind === "notes") return emptyTab()
            return { ...stored, kind } as WorkspaceTab
          }),
        ]),
      ) as Record<string, WorkspaceTab[]>
      const loaded = {
        selectedTaskId: p.selectedTaskId ?? null,
        tabsByTask,
        activeByTask: p.activeByTask ?? {},
        splitByTask: p.splitByTask ?? {},
      }
      return loaded.selectedTaskId
        ? withTaskTab(loaded, loaded.selectedTaskId)
        : loaded
    }
  } catch {
    /* ignore corrupt storage */
  }
  return EMPTY
}

let state: TabsState = typeof localStorage === "undefined" ? EMPTY : load()
const listeners = new Set<() => void>()

function set(next: TabsState): void {
  state = next
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
  for (const l of listeners) l()
}

let seq = 0
function newId(): string {
  // crypto.randomUUID where available; a cheap unique fallback otherwise.
  try {
    return crypto.randomUUID()
  } catch {
    seq += 1
    return `tab-${Date.now().toString(36)}-${seq}`
  }
}

export function selectTask(taskId: string): void {
  set(withTaskTab({ ...state, selectedTaskId: taskId }, taskId))
}

/** Open a new vendor tab for a task; returns the new tab id (now active). */
export function addTab(taskId: string): string {
  const list = state.tabsByTask[taskId] ?? []
  const id = newId()
  const vendorCount = list.filter((tab) => tab.kind === "vendor").length
  const tab: VendorTab = {
    id,
    kind: "vendor",
    title: `Vendor ${vendorCount + 1}`,
  }
  set({
    ...state,
    tabsByTask: { ...state.tabsByTask, [taskId]: [...list, tab] },
    activeByTask: { ...state.activeByTask, [taskId]: id },
    splitByTask: state.splitByTask,
  })
  return id
}

export function addEmptyTab(taskId: string): string {
  const list = state.tabsByTask[taskId] ?? []
  const tab = emptyTab()
  set({
    ...state,
    tabsByTask: { ...state.tabsByTask, [taskId]: [...list, tab] },
    activeByTask: { ...state.activeByTask, [taskId]: tab.id },
    splitByTask: state.splitByTask,
  })
  return tab.id
}

export function configureTab(
  taskId: string,
  tabId: string,
  kind: "vendor" | "terminal",
): void {
  const list = state.tabsByTask[taskId] ?? []
  const next = list.map((tab) => {
    if (tab.id !== tabId) return tab
    if (kind === "vendor") {
      const vendorCount = list.filter((item) => item.kind === "vendor").length
      return {
        id: tabId,
        kind,
        title: `Vendor ${vendorCount + 1}`,
      } satisfies VendorTab
    }
    const terminalCount = list.filter((item) => item.kind === "terminal").length
    return {
      id: tabId,
      kind,
      title: `Terminal ${terminalCount + 1}`,
    } satisfies TerminalTab
  })
  set({
    ...state,
    tabsByTask: { ...state.tabsByTask, [taskId]: next },
    activeByTask: { ...state.activeByTask, [taskId]: tabId },
    splitByTask: state.splitByTask,
  })
}

export function openFilePreviewTab(taskId: string, path: string): string {
  const list = state.tabsByTask[taskId] ?? []
  const existing = list.find((tab) => tab.kind === "file" && tab.path === path)
  if (existing) {
    setActiveTab(taskId, existing.id)
    return existing.id
  }
  const id = newId()
  const tab: FilePreviewTab = {
    id,
    kind: "file",
    title: path.split("/").at(-1) ?? path,
    path,
  }
  set({
    ...state,
    tabsByTask: { ...state.tabsByTask, [taskId]: [...list, tab] },
    activeByTask: { ...state.activeByTask, [taskId]: id },
    splitByTask: state.splitByTask,
  })
  return id
}

export function closeTab(taskId: string, tabId: string): void {
  const current = state.tabsByTask[taskId] ?? []
  const closedIndex = current.findIndex((t) => t.id === tabId)
  let list = current.filter((t) => t.id !== tabId)
  if (list.length === 0) list = [emptyTab()]
  const wasActive = state.activeByTask[taskId] === tabId
  const activeByTask = { ...state.activeByTask }
  const splitByTask = { ...state.splitByTask }
  if (wasActive) {
    const nextIndex = Math.max(0, Math.min(closedIndex, list.length - 1))
    activeByTask[taskId] = list[nextIndex].id
  }
  if (
    splitByTask[taskId] === tabId ||
    splitByTask[taskId] === activeByTask[taskId]
  )
    delete splitByTask[taskId]
  set({
    ...state,
    tabsByTask: { ...state.tabsByTask, [taskId]: list },
    activeByTask,
    splitByTask,
  })
}

export function setActiveTab(taskId: string, tabId: string): void {
  const splitByTask = { ...state.splitByTask }
  const activeByTask = { ...state.activeByTask }
  const currentActive = activeByTask[taskId]
  if (
    splitByTask[taskId] === tabId &&
    currentActive &&
    currentActive !== tabId
  ) {
    splitByTask[taskId] = currentActive
  } else if (splitByTask[taskId] === tabId) {
    delete splitByTask[taskId]
  }
  activeByTask[taskId] = tabId
  set({ ...state, activeByTask, splitByTask })
}

export function setSplitTab(taskId: string, tabId: string): void {
  const list = state.tabsByTask[taskId] ?? []
  if (!list.some((tab) => tab.id === tabId)) return
  const active = state.activeByTask[taskId]
  const activeByTask = { ...state.activeByTask }
  if (active === tabId) {
    const nextPrimary = list.find((tab) => tab.id !== tabId)
    if (!nextPrimary) return
    activeByTask[taskId] = nextPrimary.id
  }
  set({
    ...state,
    activeByTask,
    splitByTask: { ...state.splitByTask, [taskId]: tabId },
  })
}

export function clearSplitTab(taskId: string): void {
  const { [taskId]: _removed, ...splitByTask } = state.splitByTask
  set({ ...state, splitByTask })
}

export function useTabsState(): TabsState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
    () => state,
  )
}
