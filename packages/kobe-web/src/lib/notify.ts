import { useSyncExternalStore } from "react"
import type { ActivityState } from "./types.ts"

const ENABLED_KEY = "kobe-web.notify"
const ENGINE_KEY = "kobe-web.notify.engine"

type Navigate = (taskId: string) => void
let navigate: Navigate | null = null
let enabled = readEnabled()
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
  return !isAttention(opts.prev) && isAttention(opts.next)
}

export function setNotifyNavigate(fn: Navigate | null): void {
  navigate = fn
}

export interface NotifyState {
  supported: boolean
  permission: NotificationPermission
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

export async function setNotificationsEnabled(on: boolean): Promise<void> {
  if (
    on &&
    typeof Notification !== "undefined" &&
    Notification.permission === "default"
  ) {
    try {
      await Notification.requestPermission()
    } catch {}
  }
  enabled = on
  try {
    localStorage.setItem(ENABLED_KEY, on ? "1" : "0")
  } catch {}
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
  } catch {}
}
