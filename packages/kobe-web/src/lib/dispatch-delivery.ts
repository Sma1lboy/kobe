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
  } catch {}
}

export function shouldDeliver(
  event: SessionDeliver,
  deliveredAt: number,
): boolean {
  return event.at > deliveredAt
}

export async function deliverToSession(
  event: SessionDeliver,
  deps?: {
    ensureTab: (taskId: string) => string
    send: (tabId: string, taskId: string, text: string) => Promise<unknown>
  },
): Promise<boolean> {
  if (!shouldDeliver(event, lastDeliveredAt(event.taskId))) return false
  markDelivered(event.taskId, event.at)
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
