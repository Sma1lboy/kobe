/** @jsxImportSource @opentui/react */

import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { loadStateFile } from "../../state/store"
import {
  type NotificationKind,
  type NotifyInput,
  TOAST_DURATION_MS,
  type Toast,
  addUnread,
  removeUnread,
  shouldShowToast,
} from "../../tui/lib/notify-state"
import { pulse as pulseSound } from "../../tui/lib/sound"

export type { NotificationKind, Toast, NotifyInput } from "../../tui/lib/notify-state"

export interface NotificationsContext {
  readonly toasts: readonly Toast[]
  readonly unread: ReadonlyMap<string, NotificationKind>
  notify(input: NotifyInput): void
  dismiss(id: number): void
  markRead(taskId: string, tabId: string): void
}

const ctx = createContext<NotificationsContext | null>(null)

export function NotificationsProvider(props: { children?: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([])
  const [unread, setUnread] = useState<ReadonlyMap<string, NotificationKind>>(new Map())
  const prefs = useMemo(() => loadStateFile(), [])
  const counter = useRef(0)

  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(
    () => () => {
      for (const id of timers.current) clearTimeout(id)
      timers.current.clear()
    },
    [],
  )

  const dismiss = useCallback((id: number): void => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const notify = useCallback(
    (input: NotifyInput): void => {
      setUnread((prev) => addUnread(prev, input))

      if ((prefs["notifications.sound.enabled"] as boolean | undefined) !== false) {
        try {
          process.stdout.write("\x07")
        } catch {}
        pulseSound()
      }

      const toastEnabled = (prefs["notifications.toast.enabled"] as boolean | undefined) !== false
      if (shouldShowToast(input.kind, toastEnabled)) {
        const id = ++counter.current
        setToasts((prev) => [...prev, { id, ...input }])
        const timer = setTimeout(() => {
          timers.current.delete(timer)
          dismiss(id)
        }, TOAST_DURATION_MS)
        timers.current.add(timer)
      }
    },
    [prefs, dismiss],
  )

  const markRead = useCallback((taskId: string, tabId: string): void => {
    setUnread((prev) => removeUnread(prev, taskId, tabId))
  }, [])

  const value = useMemo<NotificationsContext>(
    () => ({ toasts, unread, notify, dismiss, markRead }),
    [toasts, unread, notify, dismiss, markRead],
  )

  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useNotifications(): NotificationsContext {
  const value = useContext(ctx)
  if (!value) throw new Error("useNotifications must be used within a NotificationsProvider")
  return value
}
