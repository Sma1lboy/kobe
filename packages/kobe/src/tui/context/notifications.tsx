import { type Accessor, type ParentProps, createContext, createSignal, useContext } from "solid-js"
import { createManagedTimeouts } from "../lib/managed-timeout"
import {
  type NotificationKind,
  type NotifyInput,
  TOAST_DURATION_MS,
  type Toast,
  addUnread,
  removeUnread,
  shouldShowToast,
} from "../lib/notify-state"
import { pulse as pulseSound } from "../lib/sound"
import { useKV } from "./kv"

export type { NotificationKind, Toast, NotifyInput } from "../lib/notify-state"

export interface NotificationsContext {
  toasts: Accessor<readonly Toast[]>
  unread: Accessor<ReadonlyMap<string, NotificationKind>>
  notify: (input: NotifyInput) => void
  dismiss: (id: number) => void
  markRead: (taskId: string, tabId: string) => void
}

const ctx = createContext<NotificationsContext>()

export function NotificationsProvider(props: ParentProps) {
  const kv = useKV()
  const [toasts, setToasts] = createSignal<readonly Toast[]>([])
  const [unread, setUnread] = createSignal<ReadonlyMap<string, NotificationKind>>(new Map())
  const timeouts = createManagedTimeouts()
  let counter = 0

  function notify(input: NotifyInput): void {
    setUnread((prev) => addUnread(prev, input))

    if ((kv.get("notifications.sound.enabled", true) as boolean) !== false) {
      try {
        process.stdout.write("\x07")
      } catch {}
      pulseSound()
    }

    const toastEnabled = (kv.get("notifications.toast.enabled", true) as boolean) !== false
    if (shouldShowToast(input.kind, toastEnabled)) {
      const id = ++counter
      const toast: Toast = {
        id,
        kind: input.kind,
        taskId: input.taskId,
        tabId: input.tabId,
        title: input.title,
      }
      setToasts((prev) => [...prev, toast])
      timeouts.set(() => dismiss(id), TOAST_DURATION_MS)
    }
  }

  function dismiss(id: number): void {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  function markRead(taskId: string, tabId: string): void {
    setUnread((prev) => removeUnread(prev, taskId, tabId))
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
