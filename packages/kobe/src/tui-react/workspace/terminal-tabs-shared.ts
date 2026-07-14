/**
 * Cross-component tab state shared between the mounted `TerminalTabs`
 * component and the host-side flows that need it while the component may
 * not be mounted — extracted from `TerminalTabs.tsx` for the file-size cap.
 * Module-level on purpose (framework-agnostic process state): per-task tab
 * snapshots survive task switches, and the F7 attention jump can request a
 * tab activation before the target task's tabs ever mount.
 */

import type { TabsState } from "../../tui/workspace/terminal-tabs-core"
import { type TabsSnapshotKv, forgetTaskTabsSnapshot } from "./terminal-tabs-persist"

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
