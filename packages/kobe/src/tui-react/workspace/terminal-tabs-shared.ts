/**
 * Cross-component tab state shared between the mounted `TerminalTabs`
 * component and the host-side flows that need it while the component may
 * not be mounted — extracted from `TerminalTabs.tsx` for the file-size cap.
 * Module-level on purpose (framework-agnostic process state): per-task tab
 * snapshots survive task switches, and the F7 attention jump can request a
 * tab activation before the target task's tabs ever mount.
 */

import { interactiveEngineCommand, withClaudeSessionId } from "../../engine/interactive-command"
import {
  type EngineTab,
  type TabsState,
  type TerminalTab,
  initialTabs,
  rehydrateTabs,
} from "../../tui/workspace/terminal-tabs-core"
import type { VendorId } from "../../types/vendor"
import { type TabsSnapshotKv, forgetTaskTabsSnapshot, terminalTabsKey } from "./terminal-tabs-persist"

/** Per-task tab state, preserved across task switches for the process. */
export const tabsByTask = new Map<string, TabsState>()

/** The task's currently-active tab id (module map read) — the attention
 *  jump's "where am I" input. Null when the task never mounted tabs. */
export function activeTabIdFor(taskId: string): string | null {
  return tabsByTask.get(taskId)?.activeId ?? null
}

/** Resolve a tab from live process state or its restart snapshot. */
export function knownTaskTab(kv: TabsSnapshotKv, taskId: string, tabId: string): TerminalTab | undefined {
  const saved = kv.store[terminalTabsKey(taskId)] as TabsState | null | undefined
  const state = tabsByTask.get(taskId) ?? (saved && Array.isArray(saved.tabs) ? saved : null)
  return state?.tabs.find((tab) => tab.id === tabId)
}

/**
 * Cross-component "activate this tab" request (the F7 attention jump). The
 * mounted TerminalTabs for `taskId` consumes it via the listener; a task
 * that isn't mounted yet consumes it on mount (the host selects the task
 * first, TerminalTabs mounts, then reads the pending request). Unknown tab
 * ids are dropped on consume — the tab may have closed meanwhile.
 */
let pendingTabActivation: { taskId: string; tabId: string } | null = null
export const tabActivationListeners = new Set<() => void>()

export function requestTabActivation(taskId: string, tabId: string): void {
  pendingTabActivation = { taskId, tabId }
  for (const listener of tabActivationListeners) listener()
}

/** Consume a pending activation for this task, or null. */
export function takeTabActivation(taskId: string): string | null {
  if (pendingTabActivation?.taskId !== taskId) return null
  const tabId = pendingTabActivation.tabId
  pendingTabActivation = null
  return tabId
}

/**
 * Cross-component "open a command tab" request (`tab.open` — plugin panes).
 * pendingTabActivation's twin: consumed by the mounted TerminalTabs via the
 * same listener set, or on mount for a task selected later.
 */
let pendingTabOpen: {
  taskId: string
  argv: readonly string[]
  title: string
  placement?: "split" | "tab"
} | null = null

export function requestTabOpen(
  taskId: string,
  argv: readonly string[],
  title: string,
  placement?: "split" | "tab",
): void {
  pendingTabOpen = { taskId, argv, title, placement }
  for (const listener of tabActivationListeners) listener()
}

/** Consume a pending tab-open for this task, or null. */
export function takeTabOpen(
  taskId: string,
): { argv: readonly string[]; title: string; placement?: "split" | "tab" } | null {
  if (pendingTabOpen?.taskId !== taskId) return null
  const request = pendingTabOpen
  pendingTabOpen = null
  return request
}

/**
 * UI-event bridge for plugin events: the host injects the orchestrator's
 * `reportUiEvent` once; tab open/close edges (and editor-file closes)
 * report through it. No-op until wired (mock hosts, tests, pure TUI
 * before attach).
 */
type UiEventReporter = (kind: string, taskId?: string, detail?: Record<string, unknown>) => void
let uiEventReporter: UiEventReporter | null = null

export function setUiEventReporter(fn: UiEventReporter | null): void {
  uiEventReporter = fn
}

function tabDetail(tab: TerminalTab): Record<string, unknown> {
  return {
    tabId: tab.id,
    kind: tab.kind,
    ...(tab.title ? { title: tab.title } : {}),
    ...(tab.kind === "engine" && tab.vendor ? { vendor: tab.vendor } : {}),
    ...(tab.kind === "command" && tab.purpose ? { purpose: tab.purpose } : {}),
  }
}

/**
 * Report tab.opened / tab.closed (+ file.closed when the closing tab is the
 * editor singleton) off one state transition. Called from the mounted
 * TerminalTabs' single state writer; mount-time restores never pass through
 * it, so restored tabs don't re-announce as opened.
 */
export function reportTabsDelta(taskId: string, prev: readonly TerminalTab[], next: readonly TerminalTab[]): void {
  if (!uiEventReporter || prev === next) return
  const report = uiEventReporter
  const prevIds = new Set(prev.map((tab) => tab.id))
  const nextIds = new Set(next.map((tab) => tab.id))
  for (const tab of next) if (!prevIds.has(tab.id)) report("tab.opened", taskId, tabDetail(tab))
  for (const tab of prev) {
    if (nextIds.has(tab.id)) continue
    report("tab.closed", taskId, tabDetail(tab))
    if (tab.kind === "command" && tab.purpose === "editor") {
      // The editor tab's argv ends with the absolute file path (host-built).
      const path = [...tab.command].reverse().find((arg) => arg.startsWith("/"))
      report("file.closed", taskId, { ...(path ? { path } : {}), ...(tab.title ? { title: tab.title } : {}) })
    }
  }
}

/**
 * Reclaim a DELETED task's in-process + persisted tab state (O19): drop its
 * `tabsByTask` entry (module-level, otherwise only-grows) and its
 * `terminalTabs.*` kv snapshot. Call from the task-DELETE flow only — never
 * the archived sweep (an archived task must keep its snapshot to
 * unarchive-and-`--resume`). Its PTYs are released separately by the host's
 * archived-task sweep / the tab's own exit path.
 */
export function forgetTaskTabs(kv: TabsSnapshotKv, taskId: string): void {
  tabsByTask.delete(taskId)
  forgetTaskTabsSnapshot(kv, taskId)
}

/** The task's current tab state as a NON-mounted flow sees it: the live
 *  module entry, else the persisted snapshot, else a fresh single tab. */
function currentTabsState(kv: TabsSnapshotKv, taskId: string, shell: string): TabsState {
  const inMemory = tabsByTask.get(taskId)
  if (inMemory) return inMemory
  const saved = kv.store[terminalTabsKey(taskId)] as TabsState | null | undefined
  return saved && Array.isArray(saved.tabs) ? rehydrateTabs(saved, [shell]) : initialTabs()
}

/**
 * Append an already-spawned engine tab to a task whose TerminalTabs is NOT
 * mounted — the kanban issue-start paths ("new chattab in the project
 * workspace", jump or stay). Writes the module map AND the kv snapshot so
 * the next mount (or restart) renders the tab and attaches to its live PTY.
 * Returns the created tab; the caller spawns its PTY under
 * `tabPtyKeyFor(taskId, tab)` before or right after this write.
 */
export function appendBackgroundEngineTab(
  kv: TabsSnapshotKv,
  taskId: string,
  shell: string,
  spec: {
    vendor: VendorId
    /** Pass the referenced session's id for a viewport tab (`ptyTask`) so a
     *  dead-reattach resumes THAT conversation; omit to pin a fresh one. */
    sessionId?: string | null
    ptyTask?: EngineTab["ptyTask"]
  },
): { state: TabsState; tab: EngineTab } {
  const state = currentTabsState(kv, taskId, shell)
  const ordinal = state.nextOrdinal
  const sessionId =
    spec.sessionId !== undefined
      ? spec.sessionId
      : withClaudeSessionId(interactiveEngineCommand(spec.vendor), spec.vendor).sessionId
  const tab: EngineTab = {
    kind: "engine",
    id: `tab-${ordinal}`,
    title: null,
    ordinal,
    vendor: spec.vendor,
    sessionId,
    spawned: true,
    ...(spec.ptyTask ? { ptyTask: spec.ptyTask } : {}),
  }
  const next: TabsState = {
    tabs: [...state.tabs, tab],
    activeId: tab.id,
    nextOrdinal: ordinal + 1,
  }
  tabsByTask.set(taskId, next)
  kv.set(terminalTabsKey(taskId), next)
  return { state: next, tab }
}
