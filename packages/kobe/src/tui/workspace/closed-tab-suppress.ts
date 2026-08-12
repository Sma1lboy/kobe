/**
 * Recently-closed pty keys, for the sidebar's orphan-tab backstop.
 *
 * Closing a tab updates the tab state immediately, but the sidebar's host
 * inventory (`useHostSessions`) is a 2s poll — for up to one tick it still
 * lists the killed session as alive. The orphan backstop then sees a live
 * session no snapshot answers for and ADOPTS it right back: ctrl+w needed
 * two presses. So every close notes its key here, and orphan detection
 * skips noted keys until the poll can confirm the death.
 *
 * TTL-bounded on purpose: if the kill never lands (host unreachable), the
 * session really is an orphan and must resurface after the window.
 */

const SUPPRESS_MS = 15_000

/** `taskId::tabId` → when its tab was closed. */
const closedAt = new Map<string, number>()

/** A session key's tab-level prefix — split leaves (`…::leaf-N`) belong to
 *  their tab, same rule `orphanTabsByTask` applies. */
function tabKeyOf(key: string): string {
  return key.split("::").slice(0, 2).join("::")
}

export function noteClosedPtyKey(key: string, now = Date.now()): void {
  closedAt.set(tabKeyOf(key), now)
}

export function isRecentlyClosedPtyKey(key: string, now = Date.now()): boolean {
  const tabKey = tabKeyOf(key)
  const at = closedAt.get(tabKey)
  if (at === undefined) return false
  if (now - at > SUPPRESS_MS) {
    closedAt.delete(tabKey)
    return false
  }
  return true
}
