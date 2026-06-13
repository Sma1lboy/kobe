/**
 * session.deliver → engine session forwarder (docs/design/dispatcher.md).
 *
 * The daemon's `session.deliver` channel is an address, not a delivery: the
 * daemon never touches sessions, so whichever front-end HOSTS the target
 * task's engine must do the paste. For web-hosted sessions that's this SPA
 * — the tab registry (client-generated tab ids) lives in the browser, so a
 * server-side forwarder would mint a fresh tab and spawn a DUPLICATE engine
 * for a task already open here. The forward path is exactly the board's
 * review-button path: ensureEngineTab + sendPtyText (spawn-on-send).
 *
 * Dedupe: `at` is the event's identity. SSE replays the most recent event
 * on every reconnect, and multiple open browser tabs all receive every
 * event — a localStorage high-water mark per task makes delivery
 * once-ish across both (best-effort: localStorage isn't atomic, but a
 * lost race only risks a duplicate paste, never a lost one).
 */

import type { SessionDeliver } from "./types.ts"

const MARK_PREFIX = "kobe.dispatch.deliveredAt."

function lastDeliveredAt(taskId: string): number {
  try {
    const raw = localStorage.getItem(MARK_PREFIX + taskId)
    const at = raw ? Number.parseInt(raw, 10) : 0
    return Number.isFinite(at) ? at : 0
  } catch {
    return 0
  }
}

function markDelivered(taskId: string, at: number): void {
  try {
    localStorage.setItem(MARK_PREFIX + taskId, String(at))
  } catch {
    /* private mode etc. — delivery still works, dedupe degrades */
  }
}

/** Pure decision core, exported for tests. */
export function shouldDeliver(
  event: SessionDeliver,
  deliveredAt: number,
): boolean {
  return event.at > deliveredAt
}

/**
 * Deliver one event into its task's engine session, exactly once per `at`
 * (best-effort across tabs). Injected deps default to the real tab/PTY
 * modules; tests pass fakes.
 */
export async function deliverToSession(
  event: SessionDeliver,
  deps?: {
    ensureTab: (taskId: string) => string
    send: (tabId: string, taskId: string, text: string) => Promise<unknown>
  },
): Promise<boolean> {
  if (!shouldDeliver(event, lastDeliveredAt(event.taskId))) return false
  // Mark BEFORE the async send: the race window between two browser tabs is
  // the duration of the check→mark gap, so keep it synchronous-small. A
  // failed send below un-marks, letting the next event (or reconnect
  // replay) retry.
  markDelivered(event.taskId, event.at)
  // Lazy-import the real modules only when no deps were injected — tests
  // run in node, where tabs/terminal pull browser globals.
  let ensureTab = deps?.ensureTab
  let send = deps?.send
  if (!ensureTab || !send) {
    const tabs = await import("./tabs.ts")
    const terminal = await import("./terminal.ts")
    ensureTab ??= tabs.ensureEngineTab
    send ??= terminal.sendPtyText
  }
  try {
    const tabId = ensureTab(event.taskId)
    await send(tabId, event.taskId, event.text)
    return true
  } catch (err) {
    markDelivered(event.taskId, event.at - 1)
    console.warn(
      "[dispatch-delivery] failed to deliver into session",
      event.taskId,
      err,
    )
    return false
  }
}
