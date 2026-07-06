import type { VendorId } from "@/types/vendor"

interface TabBase {
  readonly id: string
  readonly title: string | null
  readonly ordinal: number
  readonly autoTitle?: string | null
}

export interface EngineTab extends TabBase {
  readonly kind: "engine"
  readonly vendor?: VendorId
  readonly sessionId?: string | null
  readonly spawned?: boolean
}

export interface CommandTab extends TabBase {
  readonly kind: "command"
  readonly command: readonly string[]
}

export type TerminalTab = EngineTab | CommandTab

export interface TabsState {
  readonly tabs: readonly TerminalTab[]
  readonly activeId: string
  readonly nextOrdinal: number
}

export function initialTabs(): TabsState {
  return { tabs: [{ kind: "engine", id: "tab-1", title: null, ordinal: 1 }], activeId: "tab-1", nextOrdinal: 2 }
}

function insertAfterActive(state: TabsState, tab: TerminalTab): TabsState {
  const i = state.tabs.findIndex((t) => t.id === state.activeId)
  const tabs = [...state.tabs.slice(0, i + 1), tab, ...state.tabs.slice(i + 1)]
  return { tabs, activeId: tab.id, nextOrdinal: state.nextOrdinal + 1 }
}

export function addTab(state: TabsState, vendor?: VendorId): TabsState {
  const ordinal = state.nextOrdinal
  return insertAfterActive(state, { kind: "engine", id: `tab-${ordinal}`, title: null, ordinal, vendor })
}

export function openEditorTab(state: TabsState, command: readonly string[], label: string): TabsState {
  const ordinal = state.nextOrdinal
  return insertAfterActive(state, { kind: "command", id: `tab-${ordinal}`, title: label, ordinal, command })
}

export function tabToShell(state: TabsState, id: string, shell: readonly string[]): TabsState {
  const tabs = state.tabs.map(
    (t): TerminalTab =>
      t.id === id && t.kind === "engine"
        ? { kind: "command", id: t.id, title: t.title, ordinal: t.ordinal, autoTitle: t.autoTitle, command: shell }
        : t,
  )
  return { ...state, tabs }
}

export function closeTab(state: TabsState, id: string): { state: TabsState; closedId: string | null } {
  if (state.tabs.length <= 1) return { state, closedId: null }
  const i = state.tabs.findIndex((t) => t.id === id)
  if (i < 0) return { state, closedId: null }
  const tabs = state.tabs.filter((t) => t.id !== id)
  if (state.activeId !== id) return { state: { ...state, tabs }, closedId: id }
  const next = tabs[Math.max(0, i - 1)]
  return { state: { ...state, tabs, activeId: (next ?? tabs[0]).id }, closedId: id }
}

export function closeActiveTab(state: TabsState): { state: TabsState; closedId: string | null } {
  return closeTab(state, state.activeId)
}

export function renameActiveTab(state: TabsState, title: string): TabsState {
  const trimmed = title.trim()
  const tabs = state.tabs.map((t) =>
    t.id === state.activeId ? { ...t, title: trimmed.length > 0 ? trimmed : null } : t,
  )
  return { ...state, tabs }
}

export function setTabSessionId(state: TabsState, id: string, sessionId: string | null): TabsState {
  const tabs = state.tabs.map((t): TerminalTab => (t.id === id && t.kind === "engine" ? { ...t, sessionId } : t))
  return { ...state, tabs }
}

export function setTabAutoTitle(state: TabsState, id: string, autoTitle: string): TabsState {
  const tabs = state.tabs.map((t): TerminalTab => (t.id === id ? { ...t, autoTitle } : t))
  return { ...state, tabs }
}

export function markTabSpawned(state: TabsState, id: string): TabsState {
  const tabs = state.tabs.map(
    (t): TerminalTab => (t.id === id && t.kind === "engine" && !t.spawned ? { ...t, spawned: true } : t),
  )
  return { ...state, tabs }
}

export function rehydrateTabs(persisted: TabsState): TabsState {
  const tabs = persisted.tabs.filter((t): t is EngineTab => t.kind === "engine")
  if (tabs.length === 0) return initialTabs()
  const activeId = tabs.some((t) => t.id === persisted.activeId) ? persisted.activeId : tabs[0].id
  const maxOrdinal = tabs.reduce((max, t) => Math.max(max, t.ordinal), 0)
  return { tabs, activeId, nextOrdinal: Math.max(persisted.nextOrdinal, maxOrdinal + 1) }
}

export function cycleTab(state: TabsState, delta: 1 | -1): TabsState {
  const n = state.tabs.length
  if (n <= 1) return state
  const i = state.tabs.findIndex((t) => t.id === state.activeId)
  const next = state.tabs[(i + delta + n) % n]
  return { ...state, activeId: next.id }
}

export function selectTab(state: TabsState, id: string): TabsState {
  return state.tabs.some((t) => t.id === id) ? { ...state, activeId: id } : state
}

export function tabPtyKey(taskId: string, tabId: string): string {
  return `${taskId}::${tabId}`
}

export function splitLeafPtyKey(tabKey: string, leafId: string): string {
  return leafId === "leaf-1" ? tabKey : `${tabKey}::${leafId}`
}
