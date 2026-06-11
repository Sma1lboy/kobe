/**
 * Themed confirm modal — replaces native `window.confirm` (off-theme, blocks
 * the event loop). One open dialog at a time, rendered by the caller.
 */

import { useEffect, useRef } from "react"
import { useFocusTrap } from "../lib/use-focus-trap.ts"

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef)

  useEffect(() => {
    confirmRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCancel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCancel])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-dismiss is a convenience; Escape + the Cancel button are the accessible paths.
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      onClick={onCancel}
      onKeyDown={() => {}}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="w-96 border border-line bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={() => {}}
      >
        <div className="border-b border-line px-3 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-fg">
          {title}
        </div>
        <p className="px-3 py-3 text-[12px] leading-relaxed text-muted">
          {body}
        </p>
        <div className="flex justify-end gap-2 border-t border-line px-3 py-2">
          <button
            type="button"
            onClick={onCancel}
            className="border border-line bg-bg px-3 py-1 text-[11px] text-muted transition-colors hover:border-primary hover:text-fg"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`border px-3 py-1 text-[11px] transition-colors disabled:opacity-40 ${
              danger
                ? "border-kobe-red/50 bg-kobe-red/10 text-kobe-red hover:bg-kobe-red/20"
                : "border-primary bg-inset text-fg hover:bg-primary/10"
            }`}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
