/**
 * Adopt a task's live-but-unregistered pty sessions — the write side of
 * `tui/workspace/tabs-adopt.ts` (which explains why divergence is adopted
 * rather than only reported).
 *
 * Same two routes as `closeTaskTab`, for the same reason: the sidebar names
 * tabs of tasks whose `TerminalTabs` may or may not be mounted, and the
 * mounted component owns its state. Claimed → the component appends through
 * its own `update`; unclaimed → write the module map + kv snapshot here, so
 * the next mount renders the tab and attaches to the session already running
 * under its key.
 */

import { adoptTabs } from "../../tui/workspace/tabs-adopt"
import type { TabsState } from "../../tui/workspace/terminal-tabs-core"
import { type TabsSnapshotKv, terminalTabsKey } from "./terminal-tabs-persist"
import { requestTabAdopt, tabsByTask, takeUnclaimedTabAdopt } from "./terminal-tabs-shared"

/**
 * Register `tabIds` as engine tabs of `taskId`. No-op when they are all
 * known already — adoption is driven by a poll, so the common case must not
 * write. Returns whether this call wrote the background state (false also
 * covers "a mounted component claimed it").
 */
export function adoptTaskTabs(kv: TabsSnapshotKv, taskId: string, tabIds: readonly string[]): boolean {
  if (tabIds.length === 0) return false
  requestTabAdopt(taskId, tabIds)
  const unclaimed = takeUnclaimedTabAdopt()
  if (!unclaimed) return false

  const saved = kv.store[terminalTabsKey(taskId)] as TabsState | null | undefined
  const state = tabsByTask.get(taskId) ?? (saved && Array.isArray(saved.tabs) ? saved : null)
  // No state at all: the task never opened tabs, yet a session runs under
  // one of its tab keys. Start EMPTY and let adoption fill it — seeding
  // `initialTabs()` instead would invent a second, session-less `tab-1`.
  // The first adopted id is the active one, since nothing else can be.
  const empty: TabsState = { tabs: [], activeId: tabIds[0] as string, nextOrdinal: 1 }
  const next = adoptTabs(state ?? empty, tabIds)
  if (state && next === state) return false

  tabsByTask.set(taskId, next)
  kv.set(terminalTabsKey(taskId), next)
  return true
}
