/**
 * Per-ChatTab completion notifications.
 *
 * Three coordinated signals fire when a background chat-tab transitions
 * out of `running` (either to `awaiting_input` or to idle/done):
 *   1. Terminal bell (`\x07`) — once per event, gated on the
 *      `notifications.enabled` KV toggle (default on). The host terminal
 *      decides whether the bell rings, flashes, or is silenced.
 *   2. Transient toast — pushed onto the queue rendered by
 *      `<ToastOverlay />` at bottom-right. Auto-dismisses after
 *      `TOAST_DURATION_MS`.
 *   3. Unread mark on the tab chip — until the user views that tab.
 *
 * "View" means the (task, tab) is currently the active chat tab in the
 * active task with the workspace showing chat. The hook upstream of
 * `notify()` (`useCompletionNotifications`) suppresses the toast and
 * bell entirely when the (task, tab) is already visible — the user can
 * see the transition happen in real time, no notification needed.
 */

import { type Accessor, type ParentProps, createContext, createSignal, useContext } from "solid-js"
import { pulse as pulseSound } from "../lib/sound"
import { useKV } from "./kv"

export type NotificationKind = "done" | "needs_input"

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

const TOAST_DURATION_MS = 4500

export interface NotificationsContext {
  toasts: Accessor<readonly Toast[]>
  unread: Accessor<ReadonlyMap<string, NotificationKind>>
  notify: (input: NotifyInput) => void
  dismiss: (id: number) => void
  markRead: (taskId: string, tabId: string) => void
}

const ctx = createContext<NotificationsContext>()

function unreadKey(taskId: string, tabId: string): string {
  return `${taskId}:${tabId}`
}

export function NotificationsProvider(props: ParentProps) {
  const kv = useKV()
  const [toasts, setToasts] = createSignal<readonly Toast[]>([])
  const [unread, setUnread] = createSignal<ReadonlyMap<string, NotificationKind>>(new Map())
  let counter = 0

  function notify(input: NotifyInput): void {
    const enabled = kv.get("notifications.enabled", true) as boolean
    // Always update the unread map — the dot is a passive marker, not
    // an interruption, so the toggle only gates the bell + toast.
    setUnread((prev) => {
      const next = new Map(prev)
      const key = unreadKey(input.taskId, input.tabId)
      // `needs_input` outranks `done` if both fire for the same key
      // before the user clears it — yellow trumps green.
      const existing = prev.get(key)
      if (existing === "needs_input") return prev
      next.set(key, input.kind)
      return next
    })
    if (!enabled) return

    const id = ++counter
    const toast: Toast = {
      id,
      kind: input.kind,
      taskId: input.taskId,
      tabId: input.tabId,
      title: input.title,
    }
    setToasts((prev) => [...prev, toast])

    // BEL once per notification. Terminal honours its own bell settings.
    try {
      process.stdout.write("\x07")
    } catch {
      /* swallow — bell is best-effort */
    }
    // Audible chime on top of BEL. Best-effort; no-ops when no audio
    // player is on PATH (stripped CI containers, headless remote).
    pulseSound()

    setTimeout(() => dismiss(id), TOAST_DURATION_MS)
  }

  function dismiss(id: number): void {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  function markRead(taskId: string, tabId: string): void {
    setUnread((prev) => {
      const key = unreadKey(taskId, tabId)
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.delete(key)
      return next
    })
  }

  const value: NotificationsContext = {
    toasts,
    unread,
    notify,
    dismiss,
    markRead,
  }

  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useNotifications(): NotificationsContext {
  const value = useContext(ctx)
  if (!value) throw new Error("useNotifications must be used within a NotificationsProvider")
  return value
}

export function notificationKey(taskId: string, tabId: string): string {
  return unreadKey(taskId, tabId)
}
