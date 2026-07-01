/**
 * Desktop notifications for attention-needing task transitions — so you can
 * run many sessions, walk away, and get pinged when one needs you. Fires a
 * browser Notification only when a task's engine state TRANSITIONS into an
 * attention state (waiting_permission / error), the feature is enabled, and
 * the page isn't focused (no point notifying what you're already looking at).
 *
 * Opt-in: Settings requests permission and flips the persisted flag. The
 * store calls `notifyEngineTransition` from its engine-state reducer; the
 * AppShell registers a navigate callback so a notification click jumps to the
 * task.
 */

import { useSyncExternalStore } from "react"
import type { ActivityState } from "./types.ts"

const ENABLED_KEY = "kobe-web.notify"
const ENGINE_KEY = "kobe-web.notify.engine"

type Navigate = (taskId: string) => void
let navigate: Navigate | null = null
let enabled = readEnabled()
// Engine-attention is the only notification category (PR-transition pings were
// removed in the web redesign). Read once; defaults ON so an upgrade keeps it.
const engineEnabled = readEngineEnabled()
const listeners = new Set<() => void>()

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1"
  } catch {
    return false
  }
}

function readEngineEnabled(): boolean {
  try {
    return localStorage.getItem(ENGINE_KEY) !== "0"
  } catch {
    return true
  }
}

function notify(): void {
  for (const l of listeners) l()
}

function isAttention(state: ActivityState | undefined): boolean {
  return state === "waiting_permission" || state === "error"
}

/**
 * The shared opt-in gate for any notification: the feature is on, permission
 * granted, the page is hidden, and this event's category is enabled. Pure so
 * both the engine and PR paths gate identically and it's unit-testable.
 */
export function notifyGateOpen(opts: {
  enabled: boolean
  permission: NotificationPermission
  hidden: boolean
  categoryEnabled: boolean
}): boolean {
  return (
    opts.enabled &&
    opts.permission === "granted" &&
    opts.hidden &&
    opts.categoryEnabled
  )
}

/**
 * Pure decision: should an engine transition fire a notification? The shared
 * gate (incl. the `engine` category) AND a RISING edge into an attention
 * state. Extracted from {@link notifyEngineTransition} so the edge logic is
 * unit-tested without the Notification/DOM side effects.
 */
export function shouldNotify(opts: {
  prev: ActivityState | undefined
  next: ActivityState | undefined
  enabled: boolean
  permission: NotificationPermission
  hidden: boolean
  engineEnabled: boolean
}): boolean {
  if (
    !notifyGateOpen({
      enabled: opts.enabled,
      permission: opts.permission,
      hidden: opts.hidden,
      categoryEnabled: opts.engineEnabled,
    })
  )
    return false
  // Rising edge only: was NOT attention, now IS.
  return !isAttention(opts.prev) && isAttention(opts.next)
}

/** AppShell registers how to jump to a task when a notification is clicked. */
export function setNotifyNavigate(fn: Navigate | null): void {
  navigate = fn
}

export interface NotifyState {
  /** The browser supports the Notification API. */
  supported: boolean
  /** "default" | "granted" | "denied" — current browser permission. */
  permission: NotificationPermission
  /** The user has turned the feature on (and granted permission). */
  enabled: boolean
}

function permission(): NotificationPermission {
  return typeof Notification === "undefined"
    ? "denied"
    : Notification.permission
}

function snapshot(): NotifyState {
  return {
    supported: typeof Notification !== "undefined",
    permission: permission(),
    enabled: enabled && permission() === "granted",
  }
}

let cached: NotifyState = snapshot()
function getSnapshot(): NotifyState {
  const next = snapshot()
  if (
    next.supported !== cached.supported ||
    next.permission !== cached.permission ||
    next.enabled !== cached.enabled
  ) {
    cached = next
  }
  return cached
}

/** Toggle the feature; turning ON requests permission if needed. */
export async function setNotificationsEnabled(on: boolean): Promise<void> {
  if (
    on &&
    typeof Notification !== "undefined" &&
    Notification.permission === "default"
  ) {
    try {
      await Notification.requestPermission()
    } catch {
      /* user dismissed — permission stays default/denied */
    }
  }
  enabled = on
  try {
    localStorage.setItem(ENABLED_KEY, on ? "1" : "0")
  } catch {
    /* ignore */
  }
  notify()
}

export function useNotifyState(): NotifyState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getSnapshot,
    getSnapshot,
  )
}

/**
 * Called from the store's engine-state reducer with the prior + next state
 * for a task. Fires a notification only on a transition INTO an attention
 * state while the page is hidden.
 */
export function notifyEngineTransition(
  taskId: string,
  taskLabel: string,
  prev: ActivityState | undefined,
  next: ActivityState | undefined,
): void {
  const hidden =
    typeof document === "undefined" || document.visibilityState !== "visible"
  if (
    !shouldNotify({
      prev,
      next,
      enabled,
      permission: permission(),
      hidden,
      engineEnabled,
    })
  )
    return
  const verb = next === "error" ? "errored" : "needs your input"
  fire(taskId, taskLabel, `Task ${verb}.`, `kobe-task-${taskId}`)
}

function fire(
  taskId: string,
  taskLabel: string,
  body: string,
  tag: string,
): void {
  try {
    const n = new Notification(`kobe: ${taskLabel}`, { body, tag })
    n.onclick = () => {
      window.focus()
      navigate?.(taskId)
      n.close()
    }
  } catch {
    /* construction can throw on some platforms — best-effort */
  }
}
