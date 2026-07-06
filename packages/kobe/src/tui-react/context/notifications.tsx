/** @jsxImportSource @opentui/react */
/**
 * Per-ChatTab completion notifications (React port of
 * `src/tui/context/notifications.tsx`, issue #15 G3). Same three signals
 * (audible cue, transient toast, unread tab mark) and the same gating —
 * the pure state transforms + the "error toasts always show" invariant
 * live in the shared `src/tui/lib/notify-state.ts` consumed by both
 * runtimes; see the Solid header for the full rationale.
 *
 * Deliberate delta: the Solid provider reads the sound/toast toggles from
 * the live KVProvider. The React KV context isn't ported yet (issue #15
 * G3, settings slice), so this provider reads a one-shot `state.json`
 * snapshot at mount — the same snapshot-only semantics KV documents
 * (another process's writes need a restart to be seen), and no React pane
 * host has an in-process settings surface that could flip the toggles
 * live yet.
 */

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
  // ponytail: one-shot toggle snapshot; swap to the React KV context when it lands.
  const prefs = useMemo(() => loadStateFile(), [])
  const counter = useRef(0)

  // Toast auto-dismiss timers are provider-scoped: any still-pending timer
  // is cleared on unmount so `dismiss()` never fires against a torn-down
  // tree (the Solid version's createManagedTimeouts, inlined).
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
      // Always update the unread map — the dot is a passive marker, not an
      // interruption, so neither toggle gates it. Escalation rule
      // (needs_input/error outrank done) lives in the shared notify-state.
      setUnread((prev) => addUnread(prev, input))

      // Sound gate (BEL + chime). BEL alone leaks past `pulse.wav`
      // failure — they're the same intent (audible cue), one toggle.
      if ((prefs["notifications.sound.enabled"] as boolean | undefined) !== false) {
        try {
          process.stdout.write("\x07")
        } catch {
          /* swallow — bell is best-effort */
        }
        pulseSound()
      }

      // Toast gate — independent of sound; `error` always shows (shared
      // notify-state invariant).
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
