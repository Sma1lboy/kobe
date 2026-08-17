/**
 * Move a tab of ANY task — mounted or not (sidebar move mode, issue #43).
 *
 * Same two routes as `closeTaskTab`, for the same reason: the sidebar tree
 * names tabs of tasks whose `TerminalTabs` may or may not be mounted, and the
 * mounted component owns its state. Claimed → the component reorders through
 * its own `update` (which also persists); unclaimed → write the module map +
 * kv snapshot here, so the next mount renders the new order.
 *
 * Tab order is the persisted `tabs` array order (`rehydrateTabs` keeps it),
 * so a move survives restart with no new persistence key.
 */

import { type TabsState, moveTab } from "../../tui/workspace/terminal-tabs-core"
import { type TabsSnapshotKv, terminalTabsKey } from "./terminal-tabs-persist"
import { requestTabMove, tabsByTask, takeUnclaimedTabMove } from "./terminal-tabs-shared"

/**
 * Move `tabId` of `taskId` by `delta`. Returns whether the order changed —
 * false covers "no such tab", "task never opened tabs", and the edge-stop
 * (first tab up / last tab down is a no-op, never a wrap).
 */
export function moveTaskTab(kv: TabsSnapshotKv, taskId: string, tabId: string, delta: -1 | 1): boolean {
  requestTabMove(taskId, tabId, delta)
  const unclaimed = takeUnclaimedTabMove()
  // Claimed: the mounted TerminalTabs already ran the move through its own
  // state writer. Report "changed" — the component edge-stops identically.
  if (!unclaimed) return true

  const saved = kv.store[terminalTabsKey(taskId)] as TabsState | null | undefined
  const state = tabsByTask.get(taskId) ?? (saved && Array.isArray(saved.tabs) ? saved : null)
  if (!state) return false
  const next = moveTab(state, tabId, delta)
  if (next === state) return false
  tabsByTask.set(taskId, next)
  kv.set(terminalTabsKey(taskId), next)
  return true
}
