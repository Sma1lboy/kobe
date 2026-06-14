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

/** The notification categories a user can toggle independently. They fire only
 *  when the master switch is on; default ON so an upgrade keeps every ping.
 *  (PR-transition notifications were removed in the web redesign, leaving the
 *  engine-attention category — the per-event-toggle machinery stays so adding
 *  another category later is a one-line change.) */
export type NotifyCategory = "engine"
const CATEGORY_KEYS: Record<NotifyCategory, string> = {
  engine: "kobe-web.notify.engine",
}

type Navigate = (taskId: string) => void
let navigate: Navigate | null = null
let enabled = readEnabled()
let categories: Record<NotifyCategory, boolean> = {
  engine: readCategory("engine"),
}
const listeners = new Set<() => void>()

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1"
  } catch {
    return false
  }
}

/** A category defaults ON when unset (an upgrade keeps current behavior). */
function readCategory(category: NotifyCategory): boolean {
  try {
    return localStorage.getItem(CATEGORY_KEYS[category]) !== "0"
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
  /** Per-event-type toggles (only meaningful while `enabled`). */
  categories: Record<NotifyCategory, boolean>
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
    categories,
  }
}

let cached: NotifyState = snapshot()
function getSnapshot(): NotifyState {
  const next = snapshot()
  if (
    next.supported !== cached.supported ||
    next.permission !== cached.permission ||
    next.enabled !== cached.enabled ||
    next.categories !== cached.categories
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

/** Toggle one event category (engine attention / PR updates). Persisted; the
 *  master switch still gates everything. */
export function setNotifyCategory(category: NotifyCategory, on: boolean): void {
  // New object so getSnapshot's identity check sees the change.
  categories = { ...categories, [category]: on }
  try {
    localStorage.setItem(CATEGORY_KEYS[category], on ? "1" : "0")
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
      engineEnabled: categories.engine,
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
