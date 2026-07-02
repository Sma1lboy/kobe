/**
 * Per-ChatTab completion notifications.
 *
 * Three coordinated signals fire when a background chat-tab transitions
 * out of `running` (either to `awaiting_input` or to idle/done):
 *   1. Audible cue — terminal BEL (`\x07`) + a bundled `pulse.wav`
 *      chime via `lib/sound`. Gated together on the
 *      `notifications.sound.enabled` KV toggle (default on); the host
 *      terminal decides whether BEL rings, flashes, or is silenced,
 *      and the chime no-ops when no audio player is on PATH.
 *   2. Transient toast — pushed onto the queue rendered by
 *      `<ToastOverlay />` at bottom-right. Auto-dismisses after
 *      `TOAST_DURATION_MS`. Gated on `notifications.toast.enabled`
 *      (default on).
 *   3. Unread mark on the tab chip — until the user views that tab.
 *      Always on; the dot is a passive marker, not an interruption.
 *
 * Sound and toast are independent toggles so users can pick visual-only
 * (toast on, sound off — quiet office), audio-only (sound on, toast
 * off — eyes elsewhere), both, or neither.
 *
 * "View" means the (task, tab) is currently the active chat tab in the
 * active task with the workspace showing chat. The hook upstream of
 * `notify()` (`useCompletionNotifications`) suppresses every signal
 * for an already-visible (task, tab) — the user can see the transition
 * happen in real time.
 */

import { type Accessor, type ParentProps, createContext, createSignal, useContext } from "solid-js"
import { createManagedTimeouts } from "../lib/managed-timeout"
import { pulse as pulseSound } from "../lib/sound"
import { useKV } from "./kv"

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
  // Toast auto-dismiss timers are owner-scoped: any still-pending timer
  // is cleared when the provider unmounts so `dismiss()` never runs
  // against a torn-down signal.
  const timeouts = createManagedTimeouts()
  let counter = 0

  function notify(input: NotifyInput): void {
    // Always update the unread map — the dot is a passive marker, not
    // an interruption, so neither toggle gates it.
    setUnread((prev) => {
      const next = new Map(prev)
      const key = unreadKey(input.taskId, input.tabId)
      // Attention-demanding kinds outrank `done` if both fire for the
      // same key before the user clears it — yellow (`needs_input`) /
      // red (`error`) trump green.
      const existing = prev.get(key)
      if (existing === "needs_input" || existing === "error") return prev
      next.set(key, input.kind)
      return next
    })

    // Sound gate (BEL + chime). BEL alone leaks past `pulse.wav`
    // failure — they're the same intent (audible cue), so they share
    // one toggle.
    if ((kv.get("notifications.sound.enabled", true) as boolean) !== false) {
      try {
        process.stdout.write("\x07")
      } catch {
        /* swallow — bell is best-effort */
      }
      pulseSound()
    }

    // Toast gate. Independent of sound so a quiet-office user can keep
    // the visual cue without audio, and an eyes-elsewhere user can keep
    // audio without the popup. `error` always shows: error toasts are
    // failure feedback (the tasks pane routes failures through here), and
    // must not vanish into the daemon log when someone disables the
    // completion "Toast" preference — that's a silent-failure regression.
    const toastEnabled = (kv.get("notifications.toast.enabled", true) as boolean) !== false
    if (input.kind === "error" || toastEnabled) {
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
