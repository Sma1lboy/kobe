/**
 * Toast stack — bottom-right, themed like the rest of the shell (no native
 * alert/confirm styling). Errors stay until dismissed or expired; click ×
 * (or the toast body) to dismiss early.
 */

import { X } from "lucide-react"
import { dismissToast, type Toast, useToasts } from "../lib/toast.ts"

function toastTone(kind: Toast["kind"]): string {
  switch (kind) {
    case "error":
      return "border-kobe-red/50 text-kobe-red"
    case "success":
      return "border-kobe-green/50 text-kobe-green"
    default:
      return "border-line text-fg"
  }
}

export function Toasts() {
  const toasts = useToasts()
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-10 right-3 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-start gap-2 border bg-surface px-3 py-2 shadow-lg ${toastTone(toast.kind)}`}
        >
          <span className="min-w-0 flex-1 break-words text-[12px] leading-relaxed">
            {toast.message}
          </span>
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            className="shrink-0 text-subtle hover:text-fg"
            aria-label="dismiss notification"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  )
}
