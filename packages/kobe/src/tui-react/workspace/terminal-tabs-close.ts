/**
 * Close a tab of ANY task — mounted or not.
 *
 * The sidebar tree lists every worktree's tabs, so "close this tab" can name a
 * task whose `TerminalTabs` is not on screen and therefore owns no React state
 * to update. Two routes, one entry point:
 *
 *   - **Mounted** — hand the request to the component (it holds the state, the
 *     kv write, and the `tab.closed` plugin event) and let it do its own close.
 *   - **Not mounted** — write the module map + kv snapshot here and release the
 *     PTYs directly, the mirror of `appendBackgroundEngineTab`.
 *
 * Which one applies is not guessed: `requestTabClose` notifies the listener set
 * synchronously, so a request that is still pending afterwards was claimed by
 * nobody. That keeps the two paths from ever both firing.
 *
 * Split from `terminal-tabs-shared.ts` so that module keeps its narrow import
 * surface — this one reaches into the PTY registry and the split helper.
 */

import { peekSharedPtyClient } from "../../tui/panes/terminal/pty-hosted-client"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import { noteClosedPtyKey } from "../../tui/workspace/closed-tab-suppress"
import {
  type TabsState,
  type TerminalTab,
  closeTab,
  tabPtyKey,
  tabPtyKeyFor,
} from "../../tui/workspace/terminal-tabs-core"
import { releaseSplitLeaves } from "./TerminalSplit"
import { type TabsSnapshotKv, terminalTabsKey } from "./terminal-tabs-persist"
import { requestTabClose, tabsByTask, takeUnclaimedTabClose } from "./terminal-tabs-shared"

/**
 * Release a closing tab's PTYs — the split leaves plus the tab's own.
 *
 * A viewport tab (`ptyTask`) only VIEWS another task's session, so closing the
 * view must not kill it; the referenced task still owns and resumes it. Same
 * carve-out `chat.tab.close` makes.
 */
export function releaseClosedTabPtys(taskId: string, closing: TerminalTab | undefined, closedId: string): void {
  const key = closing ? tabPtyKeyFor(taskId, closing) : tabPtyKey(taskId, closedId)
  releaseSplitLeaves(key, closing?.splitTree ?? null)
  if (closing?.kind === "engine" && closing.ptyTask) return
  // The sidebar's orphan backstop polls the host on a 2s tick; until it
  // observes this kill it still lists the session as live, and would adopt
  // it right back into the state (ctrl+w needing two presses). Note the key
  // so orphan detection skips it while the death propagates.
  noteClosedPtyKey(key)
  const registry = getDefaultPtyRegistry()
  // `release()` can only kill what THIS process holds a handle for, and the
  // sidebar closes tabs of tasks it never attached to (a task not mounted
  // since the TUI started owns no local handle). Its hosted session then
  // outlived the row that named it — an engine running with no UI presence,
  // which is exactly the divergence `tabs-adopt.ts` has to clean up after.
  // So when there is no handle, tell the host directly.
  const local = registry.get(key)
  registry.release(key)
  if (!local) killHostedSession(key)
}

/** Best-effort `pty.kill` for a key with no local handle, over the shared
 *  connection IF this process has one — dialing the host here would let a
 *  tab close pin a client (see `peekSharedPtyClient`). Every failure mode
 *  (no host, no verb, dead socket) leaves the session unreachable from here,
 *  the same outcome as the kill succeeding. */
function killHostedSession(key: string): void {
  const client = peekSharedPtyClient()
  if (!client) return
  void client.then((c) => c.request("pty.kill", { key })).catch(() => {})
}

/** The tab state a non-mounted task has: its live module entry, else the
 *  persisted snapshot. Null when the task has never opened tabs — nothing to
 *  close, as opposed to `appendBackgroundEngineTab`'s "start a fresh set". */
function backgroundTabsState(kv: TabsSnapshotKv, taskId: string): TabsState | null {
  const live = tabsByTask.get(taskId)
  if (live) return live
  const saved = kv.store[terminalTabsKey(taskId)] as TabsState | null | undefined
  return saved && Array.isArray(saved.tabs) ? saved : null
}

/**
 * Close `tabId` of `taskId`. Returns whether anything closed — false covers
 * both "no such tab" and `closeTab`'s refusal to remove a task's last tab, so
 * callers can surface a single "that didn't happen" rather than guessing.
 */
export function closeTaskTab(kv: TabsSnapshotKv, taskId: string, tabId: string): boolean {
  requestTabClose(taskId, tabId)
  const unclaimed = takeUnclaimedTabClose()
  // Claimed: the mounted TerminalTabs already ran its own close path.
  if (!unclaimed) return true

  const state = backgroundTabsState(kv, taskId)
  if (!state) return false
  const closing = state.tabs.find((tab) => tab.id === tabId)
  const { state: next, closedId } = closeTab(state, tabId)
  if (!closedId) return false
  tabsByTask.set(taskId, next)
  kv.set(terminalTabsKey(taskId), next)
  releaseClosedTabPtys(taskId, closing, closedId)
  return true
}
