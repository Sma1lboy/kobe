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
import type { TabsState, TerminalTab } from "../../tui/workspace/terminal-tabs-core"
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
}): {
  turnStates: ReadonlyMap<string, ChatTabTurnState>
  liveTitles: ReadonlyMap<string, string>
  turnVendors: ReadonlyMap<string, VendorId>
} {
  const { turnStates: pollStates, liveTitles, turnVendors } = useTurnPolls(deps)

  const turnStates = useMemo(() => mergeTurnStates(deps.hookTabStates, pollStates), [deps.hookTabStates, pollStates])

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
