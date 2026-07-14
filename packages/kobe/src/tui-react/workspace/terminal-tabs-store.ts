/**
 * Module-level terminal-tab state shared across TerminalTabs mounts —
 * extracted from `TerminalTabs.tsx` (file-size cap) and framework-free so
 * non-mounted flows can mutate it: per-task tab state survives task
 * switches, the attention jump can target a tab before its task mounts,
 * and the kanban board can append a background issue tab to a workspace
 * that isn't on screen.
 *
 * Ownership: the mounted TerminalTabs for a task is the writer while it's
 * up; `appendBackgroundEngineTab` writes only for tasks whose TerminalTabs
 * is NOT mounted (the workspace host swaps to a full page — kanban — before
 * the board can start anything, so the two writers never overlap).
 */

import { interactiveEngineCommand, withClaudeSessionId } from "../../engine/interactive-command"
import { type EngineTab, type TabsState, initialTabs, rehydrateTabs } from "../../tui/workspace/terminal-tabs-core"
import type { VendorId } from "../../types/vendor"
import { type TabsSnapshotKv, forgetTaskTabsSnapshot, terminalTabsKey } from "./terminal-tabs-persist"

/** Per-task tab state, preserved across task switches for the process. */
export const tabsByTask = new Map<string, TabsState>()

/** The task's currently-active tab id (module map read) — the attention
 *  jump's "where am I" input. Null when the task never mounted tabs. */
export function activeTabIdFor(taskId: string): string | null {
  return tabsByTask.get(taskId)?.activeId ?? null
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
