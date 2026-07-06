/**
 * Framework-free notification state (issue #15, G3) — the pure map
 * transforms + gating rules behind the per-ChatTab completion
 * notifications, shared by the Solid provider
 * (`src/tui/context/notifications.tsx`) and the React port
 * (`src/tui-react/context/notifications.tsx`). Keeping the escalation
 * rule ("needs_input / error outrank done") and the "error toasts always
 * show" invariant in one place means both runtimes can't drift.
 */

export type NotificationKind = "done" | "needs_input" | "error"

export interface Toast {
  readonly id: number
  readonly kind: NotificationKind
  readonly taskId: string
  readonly tabId: string
  readonly title: string
}

export interface NotifyInput {
  readonly kind: NotificationKind
  readonly taskId: string
  readonly tabId: string
  readonly title: string
}

export const TOAST_DURATION_MS = 4500

export function unreadKey(taskId: string, tabId: string): string {
  return `${taskId}:${tabId}`
}

/**
 * Merge a notification into the unread map. Attention-demanding kinds
 * outrank `done` if both fire for the same key before the user clears it —
 * yellow (`needs_input`) / red (`error`) trump green. Returns `prev`
 * unchanged when the existing mark already outranks the new one.
 */
export function addUnread(
  prev: ReadonlyMap<string, NotificationKind>,
  input: NotifyInput,
): ReadonlyMap<string, NotificationKind> {
  const key = unreadKey(input.taskId, input.tabId)
  const existing = prev.get(key)
  if (existing === "needs_input" || existing === "error") return prev
  const next = new Map(prev)
  next.set(key, input.kind)
  return next
}

/** Clear the unread mark for a (task, tab). Returns `prev` when absent. */
export function removeUnread(
  prev: ReadonlyMap<string, NotificationKind>,
  taskId: string,
  tabId: string,
): ReadonlyMap<string, NotificationKind> {
  const key = unreadKey(taskId, tabId)
  if (!prev.has(key)) return prev
  const next = new Map(prev)
  next.delete(key)
  return next
}

/**
 * Toast gate. `error` always shows: error toasts are failure feedback and
 * must not vanish into the daemon log when the user disables the
 * completion "Toast" preference — that's a silent-failure regression.
 */
export function shouldShowToast(kind: NotificationKind, toastEnabled: boolean): boolean {
  return kind === "error" || toastEnabled
}
