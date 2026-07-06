import { useSyncExternalStore } from "react"
import {
  nextTabTitle,
  TAB_KINDS,
  tabHasPty,
  type WorkspaceTabKind,
} from "./tab-kinds.ts"
import { closePtyTab } from "./terminal.ts"

const KEY = "kobe-web.tabs"

export type { WorkspaceTabKind }

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

export interface TranscriptTab {
  id: string
  kind: "transcript"
  title: string
}

export interface FilePreviewTab {
  id: string
  kind: "file"
  title: string
  path: string
}

export type WorkspaceTab =
  | EmptyTab
  | VendorTab
  | TerminalTab
  | TranscriptTab
  | FilePreviewTab

export interface TabsState {
  selectedTaskId: string | null
  tabsByTask: Record<string, WorkspaceTab[]>
  activeByTask: Record<string, string>
  splitByTask: Record<string, string>
}

const EMPTY: TabsState = {
  selectedTaskId: null,
  tabsByTask: {},
  activeByTask: {},
  splitByTask: {},
}

function emptyTab(): EmptyTab {
  return { id: newId(), kind: "empty", title: nextTabTitle("empty", []) }
}

export function withTaskTab(next: TabsState, taskId: string): TabsState {
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

export function migrateStoredTab(tab: unknown): WorkspaceTab {
  const stored = tab as Partial<WorkspaceTab>
  const storedKind =
    typeof (tab as { kind?: unknown })?.kind === "string"
      ? (tab as { kind: string }).kind
      : undefined
  if (storedKind === "notes") return emptyTab()
  const remapped = storedKind === "chat" ? "vendor" : (storedKind ?? "vendor")
  const kind: WorkspaceTabKind =
    remapped in TAB_KINDS ? (remapped as WorkspaceTabKind) : "vendor"
  if (
    kind === "file" &&
    typeof (stored as { path?: unknown }).path !== "string"
  ) {
    return emptyTab()
  }
  return { ...stored, kind } as WorkspaceTab
}

function load(): TabsState {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<TabsState>
      const tabsByTask = Object.fromEntries(
        Object.entries(p.tabsByTask ?? {}).map(([taskId, tabs]) => [
          taskId,
          tabs.map(migrateStoredTab),
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
  } catch {}
  return EMPTY
}

let state: TabsState = typeof localStorage === "undefined" ? EMPTY : load()
const listeners = new Set<() => void>()

function set(next: TabsState): void {
  state = next
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {}
  for (const l of listeners) l()
}

let seq = 0
function newId(): string {
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

const pendingPrompts = new Map<string, string>()

export function setPendingPrompt(taskId: string, prompt: string): void {
  pendingPrompts.set(taskId, prompt)
}

export function consumePendingPrompt(taskId: string): string | null {
  const prompt = pendingPrompts.get(taskId)
  if (prompt === undefined) return null
  pendingPrompts.delete(taskId)
  return prompt
}

export function resetLayout(): void {
  for (const tabs of Object.values(state.tabsByTask)) {
    for (const tab of tabs) {
      if (tabHasPty(tab.kind)) void closePtyTab(tab.id)
    }
  }
  set({ ...EMPTY })
}

export function pruneMissingTasks(liveTaskIds: ReadonlySet<string>): void {
  const dead = Object.keys(state.tabsByTask).filter(
    (id) => !liveTaskIds.has(id),
  )
  const selectionDead =
    state.selectedTaskId !== null && !liveTaskIds.has(state.selectedTaskId)
  if (dead.length === 0 && !selectionDead) return
  for (const taskId of dead) {
    for (const tab of state.tabsByTask[taskId] ?? []) {
      if (tabHasPty(tab.kind)) void closePtyTab(tab.id)
    }
  }
  const tabsByTask = { ...state.tabsByTask }
  const activeByTask = { ...state.activeByTask }
  const splitByTask = { ...state.splitByTask }
  for (const taskId of dead) {
    delete tabsByTask[taskId]
    delete activeByTask[taskId]
    delete splitByTask[taskId]
  }
  set({
    selectedTaskId: selectionDead ? null : state.selectedTaskId,
    tabsByTask,
    activeByTask,
    splitByTask,
  })
}

export function clearSelectedTask(): void {
  set({ ...state, selectedTaskId: null })
}

export function addTab(taskId: string): string {
  const list = state.tabsByTask[taskId] ?? []
  const id = newId()
  const tab: VendorTab = {
    id,
    kind: "vendor",
    title: nextTabTitle("vendor", list),
  }
  set({
    ...state,
    tabsByTask: { ...state.tabsByTask, [taskId]: [...list, tab] },
    activeByTask: { ...state.activeByTask, [taskId]: id },
    splitByTask: state.splitByTask,
  })
  return id
}

export function ensureEngineTab(taskId: string): string {
  const list = state.tabsByTask[taskId] ?? []
  const existing = list.find((tab) => tab.kind === "vendor")
  if (existing) return existing.id
  const id = newId()
  const tab: VendorTab = {
    id,
    kind: "vendor",
    title: nextTabTitle("vendor", list),
  }
  set({
    ...state,
    tabsByTask: { ...state.tabsByTask, [taskId]: [...list, tab] },
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
  kind: "vendor" | "terminal" | "transcript",
): void {
  const list = state.tabsByTask[taskId] ?? []
  const next = list.map((tab) => {
    if (tab.id !== tabId) return tab
    if (kind === "vendor") {
      return {
        id: tabId,
        kind,
        title: nextTabTitle("vendor", list),
      } satisfies VendorTab
    }
    if (kind === "transcript") {
      return {
        id: tabId,
        kind,
        title: nextTabTitle("transcript", list),
      } satisfies TranscriptTab
    }
    return {
      id: tabId,
      kind,
      title: nextTabTitle("terminal", list),
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
