/**
 * Toast store — the web UI's one error/notice surface. RPC failures used to
 * be swallowed (`.catch(() => {})`) so a failed rename/archive/create looked
 * like nothing happened; every mutation path now reports here instead.
 * Module-level store + useSyncExternalStore, same pattern as store.ts/tabs.ts.
 */

import { useSyncExternalStore } from "react"

export type ToastKind = "error" | "success" | "info"

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

const EXPIRE_MS = 5_000
const MAX_TOASTS = 4

let toasts: readonly Toast[] = []
let seq = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

export function pushToast(kind: ToastKind, message: string): void {
  seq += 1
  const toast: Toast = { id: seq, kind, message }
  toasts = [...toasts.slice(-(MAX_TOASTS - 1)), toast]
  emit()
  window.setTimeout(() => dismissToast(toast.id), EXPIRE_MS)
}

export function dismissToast(id: number): void {
  if (!toasts.some((t) => t.id === id)) return
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

/** Standard shape for a failed mutation: `label: cause`. An Error contributes
 *  its message; anything else is stringified. Pure + exported so the contract
 *  is testable without the window-bound toast store. */
export function formatError(label: string, err: unknown): string {
  const cause = err instanceof Error ? err.message : String(err)
  return `${label}: ${cause}`
}

/** Standard shape for a failed mutation: `label: cause`. */
export function reportError(label: string, err: unknown): void {
  pushToast("error", formatError(label, err))
}

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => toasts,
    () => toasts,
  )
}
