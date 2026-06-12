/**
 * Tab + selection state, persisted in localStorage.
 *
 * Two levels: the workspace shows ONE selected TASK, and each task has its
 * OWN list of workspace tabs. Chat tabs are independent engine renders (their
 * own PTYs). File tabs are lightweight previews opened from the right Changes
 * rail. The whole list is purely client-owned and persisted here.
 */

import { useSyncExternalStore } from "react"
import { closePtyTab } from "./terminal.ts"

const KEY = "kobe-web.tabs"

export type WorkspaceTabKind =
  | "empty"
  | "vendor"
  | "terminal"
  | "transcript"
  | "file"

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

/** Structured engine-history view (read-only chat render, not a PTY). */
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

/**
 * Normalize one task's slice of the tab state: drop a split that's gone stale
 * (its tab closed) or redundant (equal to the active tab), pick a valid active
 * tab when the current one is missing, and mint a fresh empty tab when the task
 * has none. Returns the SAME reference when nothing needed fixing so React
 * skips a render. Pure (a fresh empty tab mints a new id); exported for tests.
 */
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

/**
 * Migrate one stored tab object to a current {@link WorkspaceTab}. Stale
 * localStorage can carry retired kinds — `notes` (the old right-rail tab,
 * now an empty chooser) and `chat` (renamed to `vendor`); anything without a
 * recognized kind defaults to `vendor`. Pure (a `notes` migration mints a
 * fresh empty tab id); exported for tests.
 */
export function migrateStoredTab(tab: unknown): WorkspaceTab {
  const stored = tab as Partial<WorkspaceTab>
  const storedKind =
    typeof (tab as { kind?: unknown })?.kind === "string"
      ? (tab as { kind: string }).kind
      : undefined
  if (storedKind === "notes") return emptyTab()
  const kind = storedKind === "chat" ? "vendor" : (storedKind ?? "vendor")
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

/**
 * A first prompt to seed into a freshly-created task's engine composer.
 * Not persisted — a one-shot, consumed by the first engine ChatTerminal that
 * mounts for the task. (No PTY-readiness timing games: it pre-fills the
 * composer draft so the user sends when the engine is ready.)
 */
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

/**
 * Reset all client-owned workspace layout (tab lists, splits, selection) back
 * to empty — a recovery hatch from a wedged/cluttered tab state. Pure client
 * state: clears localStorage, doesn't touch tasks/worktrees/the daemon. PTYs
 * for currently-open tabs are killed so they don't linger server-side.
 */
export function resetLayout(): void {
  for (const tabs of Object.values(state.tabsByTask)) {
    for (const tab of tabs) {
      if (tab.kind === "vendor" || tab.kind === "terminal")
        void closePtyTab(tab.id)
    }
  }
  set({ ...EMPTY })
}

/**
 * Sweep tab state for tasks that no longer exist (deleted in the TUI, via
 * `kobe api`, or by another browser). Kills the dead tasks' PTYs server-side
 * — without this, a deleted task's engine kept running in the pty sidecar,
 * orphaned and invisible (same bug class as the tmux orphan `kobe api delete`
 * had). Call ONLY with an authoritative live-daemon task list.
 */
export function pruneMissingTasks(liveTaskIds: ReadonlySet<string>): void {
  const dead = Object.keys(state.tabsByTask).filter(
    (id) => !liveTaskIds.has(id),
  )
  const selectionDead =
    state.selectedTaskId !== null && !liveTaskIds.has(state.selectedTaskId)
  if (dead.length === 0 && !selectionDead) return
  for (const taskId of dead) {
    for (const tab of state.tabsByTask[taskId] ?? []) {
      if (tab.kind === "vendor" || tab.kind === "terminal")
        void closePtyTab(tab.id)
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

/**
 * The task's engine tab id, minting a vendor tab when none exists. The
 * board's peek drawer attaches by THIS id so peek and workspace are two
 * views of ONE server-side PTY — tab ids key PTY processes, so a
 * drawer-private id would spawn a second engine instance for the task.
 *
 * Unlike addTab this does NOT steal the task's active tab: a peek is a
 * glance, not a workspace edit. (A task with no tabs at all still lands on
 * the minted vendor tab next workspace visit — withTaskTab picks list[0].)
 */
export function ensureEngineTab(taskId: string): string {
  const list = state.tabsByTask[taskId] ?? []
  const existing = list.find((tab) => tab.kind === "vendor")
  if (existing) return existing.id
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
      const vendorCount = list.filter((item) => item.kind === "vendor").length
      return {
        id: tabId,
        kind,
        title: `Vendor ${vendorCount + 1}`,
      } satisfies VendorTab
    }
    if (kind === "transcript") {
      return { id: tabId, kind, title: "Chat" } satisfies TranscriptTab
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
