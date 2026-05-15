import type { OrchestratorEvent } from "../types/engine.ts"
import type { ChatTab, Task, TaskId, VendorId } from "../types/task.ts"
import { nextChatTabSeq } from "../types/task.ts"
import type { TaskIndexStore } from "./index/store.ts"

export interface ChatTabLifecycleDeps {
  readonly store: TaskIndexStore
  readonly createId: () => string
  readonly nowIso: () => string
  readonly vendorForTab: (task: Task, tab: ChatTab) => VendorId
  readonly stopTab: (taskId: TaskId, tabId: string) => Promise<void>
  readonly dispatchEvent: (taskId: TaskId, tabId: string, ev: OrchestratorEvent) => void
}

/**
 * Resolve a chat tab on a task. When `tabId` is omitted, returns the
 * task's active tab. Throws if the tab id is given but not found.
 */
export function resolveChatTab(task: Task, tabId?: string): ChatTab {
  if (tabId) {
    const found = task.tabs.find((t) => t.id === tabId)
    if (!found) throw new Error(`tab not found on task ${task.id}: ${tabId}`)
    return found
  }
  const active = task.tabs.find((t) => t.id === task.activeTabId) ?? task.tabs[0]
  if (!active) {
    // Should be impossible — the store invariant guarantees tabs.length >= 1.
    throw new Error(`task ${task.id} has no tabs`)
  }
  return active
}

/**
 * Patch a single tab's persisted fields.
 */
export async function updateChatTab(
  store: TaskIndexStore,
  taskId: TaskId,
  tabId: string,
  patch: Partial<ChatTab>,
): Promise<void> {
  const cur = store.get(taskId)
  if (!cur) return
  const tabs = cur.tabs.map((t) => (t.id === tabId ? { ...t, ...patch, id: t.id } : t))
  await store.update(taskId, { tabs })
}

export async function setChatTabTitle(store: TaskIndexStore, task: Task, tabId: string, title: string): Promise<void> {
  const trimmed = typeof title === "string" ? title.trim() : ""
  if (trimmed.length === 0) {
    throw new Error("setTabTitle: title is required (empty or whitespace-only rejected)")
  }
  const idx = task.tabs.findIndex((t) => t.id === tabId)
  if (idx < 0) {
    throw new Error(`setTabTitle: tab ${tabId} not found on task ${task.id}`)
  }
  const current = task.tabs[idx]
  if (!current) return
  if (current.title === trimmed) return
  const nextTabs = task.tabs.map((t) => (t.id === tabId ? { ...t, title: trimmed } : t))
  await store.update(task.id, { tabs: nextTabs })
}

export async function openSessionInChatTab(
  deps: ChatTabLifecycleDeps,
  task: Task,
  sessionId: string,
  opts: { title?: string; vendor?: VendorId; source?: ChatTab["source"] } = {},
): Promise<string> {
  const active = resolveChatTab(task)
  const targetVendor = opts.vendor ?? deps.vendorForTab(task, active)
  const existing = task.tabs.find((t) => t.sessionId === sessionId && deps.vendorForTab(task, t) === targetVendor)
  if (existing) {
    await setActiveChatTab(deps.store, task, existing.id)
    return existing.id
  }
  const tab: ChatTab = {
    id: deps.createId(),
    sessionId,
    seq: nextChatTabSeq(task.tabs),
    createdAt: deps.nowIso(),
    model: active.model ?? task.model,
    modelEffort: active.modelEffort ?? task.modelEffort,
    vendor: targetVendor,
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.source ? { source: opts.source } : {}),
  }
  await deps.store.update(task.id, { tabs: [...task.tabs, tab], activeTabId: tab.id })
  return tab.id
}

export async function createChatTab(
  deps: ChatTabLifecycleDeps,
  task: Task,
  opts: { title?: string } = {},
): Promise<ChatTab> {
  const active = resolveChatTab(task)
  const {
    id: _activeId,
    sessionId: _activeSessionId,
    title: _activeTitle,
    seq: _activeSeq,
    createdAt: _activeCreatedAt,
    source: _activeSource,
    ...activeConfig
  } = active
  const tab: ChatTab = {
    ...activeConfig,
    id: deps.createId(),
    sessionId: null,
    seq: nextChatTabSeq(task.tabs),
    createdAt: deps.nowIso(),
    model: activeConfig.model ?? task.model,
    modelEffort: activeConfig.modelEffort ?? task.modelEffort,
    vendor: activeConfig.vendor ?? deps.vendorForTab(task, active),
    ...(opts.title ? { title: opts.title } : {}),
  }
  const tabs = [...task.tabs, tab]
  await deps.store.update(task.id, { tabs })
  return tab
}

export async function clearChatTab(deps: ChatTabLifecycleDeps, task: Task, tabId: string): Promise<void> {
  if (!task.tabs.some((t) => t.id === tabId)) {
    throw new Error(`clearTab: tab ${tabId} not found on task ${task.id}`)
  }
  await deps.stopTab(task.id, tabId)
  await updateChatTab(deps.store, task.id, tabId, { sessionId: null })
  deps.dispatchEvent(task.id, tabId, { type: "chat.tab.cleared" })
}

export async function closeChatTab(deps: ChatTabLifecycleDeps, task: Task, tabId: string): Promise<string> {
  if (task.tabs.length <= 1) {
    throw new Error(`closeTab: refusing to close the last tab on task ${task.id}`)
  }
  const idx = task.tabs.findIndex((t) => t.id === tabId)
  if (idx < 0) {
    throw new Error(`closeTab: tab ${tabId} not found on task ${task.id}`)
  }

  await deps.stopTab(task.id, tabId)

  const remaining = task.tabs.filter((t) => t.id !== tabId)
  let nextActive = task.activeTabId
  if (task.activeTabId === tabId) {
    const prevIdx = Math.max(0, idx - 1)
    nextActive = remaining[prevIdx]?.id ?? remaining[0]?.id ?? ""
  }
  await deps.store.update(task.id, { tabs: remaining, activeTabId: nextActive })
  return nextActive
}

export async function setActiveChatTab(store: TaskIndexStore, task: Task, tabId: string): Promise<void> {
  if (!task.tabs.some((t) => t.id === tabId)) {
    throw new Error(`setActiveTab: tab ${tabId} not found on task ${task.id}`)
  }
  if (task.activeTabId === tabId) return
  await store.update(task.id, { activeTabId: tabId })
}
