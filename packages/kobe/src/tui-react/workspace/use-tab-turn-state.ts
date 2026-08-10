/**
 * Per-tab turn state for the workspace tab strip — hook-first, poll-fallback
 * (the consolidation seam). Wraps `useTurnPolls` (the capture-pane
 * quiescence poll, still the source for `liveTitles`/`turnVendors` and the
 * no-hooks fallback) and merges the daemon's hook-driven per-tab engine
 * state over it (`turn-state-merge.ts`, hook-wins per tabId). Also owns the
 * per-tab background-attention notifications that used to live inline in
 * `TerminalTabs`: a rising edge into done/error/needs_input on a NON-active
 * tab fires `notif.notify` (toast + unread). Edge detection is the shared
 * framework-free `attentionEdges` (seed rule inside — a fresh mount's
 * replayed sticky `turn_complete` paints the ✓ chip but never re-fires a
 * toast; `TerminalTabs` remounts per worktree via `key={path}`, so task
 * switches re-seed).
 */

import { useEffect, useMemo, useRef } from "react"
import type { TranscriptActivity } from "../../client/remote-orchestrator"
import type { ChatTabTurnState } from "../../engine/turn-detector"
import { attentionEdges, chipAttentionKind } from "../../tui/lib/notify-state"
import { defaultShell } from "../../tui/panes/terminal/pty-types"
import { demoteExitedEngine } from "../../tui/workspace/terminal-tab-identity"
import {
  type TabsState,
  type TerminalTab,
  setTabLastTitle,
  setTabLiveVendor,
} from "../../tui/workspace/terminal-tabs-core"
import { type HookTabState, mergeTurnStates } from "../../tui/workspace/turn-state-merge"
import type { VendorId } from "../../types/vendor"
import type { NotificationsContext } from "../context/notifications"
import { useLatest } from "../lib/use-latest"
import { tabTitle } from "./tab-strip"
import { useTurnPolls } from "./use-turn-polls"

export function useTabTurnState(deps: {
  taskId: string
  worktree: string
  vendor: VendorId
  state: TabsState
  sharedActivity?: TranscriptActivity | null
  /** This task's slice of the daemon's per-tab engine-state push. */
  hookTabStates?: ReadonlyMap<string, HookTabState>
  /** Task title — the toast's context line under the tab label. */
  taskTitle?: string
  notif: NotificationsContext
  /** Tab-state writer — used to RECORD each tab's latest live title. */
  update?: (next: TabsState) => void
}): {
  turnStates: ReadonlyMap<string, ChatTabTurnState>
  liveTitles: ReadonlyMap<string, string>
  turnVendors: ReadonlyMap<string, VendorId>
} {
  const { turnStates: pollStates, liveTitles, turnVendors } = useTurnPolls(deps)

  const turnStates = useMemo(() => mergeTurnStates(deps.hookTabStates, pollStates), [deps.hookTabStates, pollStates])

  // Record the live titles AND live engine identity onto the tabs
  // themselves. Only THIS component sees the OSC stream / turn targets, and
  // only for the task it hosts — so a surface rendering someone else's tab
  // (the Inbox, the sidebar tree) would otherwise fall back to `autoTitle`
  // and, after a restart, demote a shell-turned-agent to a plain shell (the
  // fresh process's registry has no PTY to probe until the tab mounts).
  // Both setters return the same state when nothing changed, so repeated
  // pushes never churn the persisted snapshot. Identity writes only cover
  // tabs WITH a live title — that means an attached PTY, where a missing
  // vendor genuinely means "no engine running" rather than "not probed yet".
  const updateRef = useLatest(deps.update)
  const titleStateRef = useLatest(deps.state)
  useEffect(() => {
    const apply = updateRef.current
    if (!apply) return
    const current = titleStateRef.current
    let next = current
    for (const [tabId, title] of liveTitles) {
      const live = turnVendors.get(tabId) ?? null
      // The engine this tab was running is gone (vendor → confirmed null):
      // reset the tab to the shell it always was, BEFORE recording the new
      // identity. `kind` describes what runs here now — leaving it at
      // "engine" is what kept a dot on the sidebar row and made every
      // keystroke mark an optimistic turn for a session that had exited.
      const tab = next.tabs.find((t) => t.id === tabId)
      const demoted = tab ? demoteExitedEngine(tab, tab.liveVendor, live, [defaultShell()]) : undefined
      if (tab && demoted && demoted !== tab) {
        next = { ...next, tabs: next.tabs.map((t) => (t.id === tabId ? demoted : t)) }
        continue // the reset already cleared lastTitle/liveVendor
      }
      next = setTabLastTitle(next, tabId, title)
      next = setTabLiveVendor(next, tabId, live)
    }
    if (next !== current) apply(next)
  }, [liveTitles, turnVendors])

  // Rising-edge notify for background tabs. `prev === null` until the first
  // observation lands (attentionEdges' seed rule). Refs for values the
  // effect reads but must not re-run on.
  const prevRef = useRef<ReadonlyMap<string, string> | null>(null)
  const stateRef = useLatest(deps.state)
  const notifRef = useLatest(deps.notif)
  const vendorRef = useLatest(deps.vendor)
  const taskIdRef = useLatest(deps.taskId)
  const taskTitleRef = useLatest(deps.taskTitle)
  useEffect(() => {
    const next = new Map<string, string>()
    for (const [tabId, turn] of turnStates) next.set(tabId, turn)
    const edges = attentionEdges(prevRef.current, next, stateRef.current.activeId, chipAttentionKind)
    prevRef.current = next
    for (const { key: tabId, kind } of edges) {
      const tab: TerminalTab | undefined = stateRef.current.tabs.find((tb) => tb.id === tabId)
      if (!tab) continue
      notifRef.current.notify({
        kind,
        taskId: taskIdRef.current,
        tabId,
        // Toast identity mirrors the Inbox card: tab label leads, task
        // title is the context body line.
        title: tabTitle(tab, vendorRef.current),
        body: taskTitleRef.current,
      })
    }
  }, [turnStates])

  return { turnStates, liveTitles, turnVendors }
}
