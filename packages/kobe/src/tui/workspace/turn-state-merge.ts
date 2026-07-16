/**
 * Hook-wins merge of the two per-tab turn-state sources (framework-free).
 *
 * Two chains report "what is this tab's engine doing": the daemon's
 * hook-driven `engine-state` push (sub-second, carries `tabId` for every
 * kobe-spawned engine tab) and the local capture-pane quiescence poll
 * (3–6 s, works without hooks). This module owns the precedence rule:
 * per tabId, a live hook entry supersedes the poll's reading; the poll
 * keeps running untouched and re-owns the tab the moment the hook entry
 * clears (daemon publishes idle → client deletes the map entry) or never
 * appears (hooks not installed, daemon down when the hook fired). No
 * timers, no vendor knowledge — with no hook data the output is the poll
 * map byte-for-byte.
 *
 * Known ceiling: a dropped Stop pins the hook's `running` until the
 * daemon's per-tab lapse watchdog idles it (~10 min TTL) or the next
 * event; the poll's (correct) `done` is ignored for that window.
 */

import type { TaskActivityState } from "../../engine/hook-events.ts"
import type { ChatTabTurnState } from "../../engine/turn-detector.ts"

/** The slice of the client's `TaskEngineState` this merge consumes. */
export interface HookTabState {
  readonly state: TaskActivityState
}

/**
 * Daemon activity state → tab-chip vocabulary. `null` = "no hook claim"
 * (idle entries are deleted client-side, but a replayed idle can still
 * arrive here — treat it as no-claim so the poll owns the chip).
 */
export function activityTurnState(state: TaskActivityState): ChatTabTurnState | null {
  switch (state) {
    case "running":
      return "running"
    case "turn_complete":
      return "done"
    case "error":
    case "rate_limited":
      return "error"
    case "permission_needed":
      return "needs_input"
    case "idle":
      return null
  }
}

/**
 * Merge hook-derived tab states over the poll's map, hook-wins per tabId.
 * Returns `poll` unchanged (same reference) when no hook entry claims any
 * tab — callers can identity-compare to skip downstream work.
 */
export function mergeTurnStates(
  hook: ReadonlyMap<string, HookTabState> | undefined,
  poll: ReadonlyMap<string, ChatTabTurnState>,
): ReadonlyMap<string, ChatTabTurnState> {
  if (!hook || hook.size === 0) return poll
  let out: Map<string, ChatTabTurnState> | null = null
  for (const [tabId, entry] of hook) {
    const turn = activityTurnState(entry.state)
    if (turn === null) continue
    if (!out) out = new Map(poll)
    out.set(tabId, turn)
  }
  return out ?? poll
}
