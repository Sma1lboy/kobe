import { createExternalStore } from "./external-store.ts"

export type ToastKind = "error" | "success" | "info"

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

const EXPIRE_MS = 5_000
const MAX_TOASTS = 4

const store = createExternalStore<readonly Toast[]>([])
let seq = 0

export function pushToast(kind: ToastKind, message: string): void {
  seq += 1
  const toast: Toast = { id: seq, kind, message }
  store.update((toasts) => [...toasts.slice(-(MAX_TOASTS - 1)), toast])
  window.setTimeout(() => dismissToast(toast.id), EXPIRE_MS)
}

export function dismissToast(id: number): void {
  const toasts = store.getSnapshot()
  if (!toasts.some((t) => t.id === id)) return
  store.replace(toasts.filter((t) => t.id !== id))
}

export function formatError(label: string, err: unknown): string {
  const cause = err instanceof Error ? err.message : String(err)
  return `${label}: ${cause}`
}

export function reportError(label: string, err: unknown): void {
  pushToast("error", formatError(label, err))
}

export function useToasts(): readonly Toast[] {
  return store.useSnapshot()
}
