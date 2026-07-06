/**
 * SlideOver — a reusable right-docked drawer, the shared chrome behind the
 * Board's issue surfaces (intake panel, issue detail). The structure is lifted
 * from IssuePeek's drawer: a fixed full-screen backdrop, a right-edge panel
 * with a focus trap, and Escape/backdrop close (Escape leaves text fields
 * alone so it doesn't yank you out of the title input mid-edit).
 *
 * What it adds over the IssuePeek precedent is a slide-in: the panel mounts at
 * translate-x-full, then flips to translate-x-0 on the next layout tick so the
 * browser animates the transform. motion-reduce drops the animation entirely.
 *
 * `wide` opts a panel into a much wider shell (w-[920px] vs the default
 * w-[640px]) so a two-column body — e.g. the redesigned issue detail's
 * ticket/config split — has room without each surface feeling cramped. It only
 * touches the panel width; every other behavior (slide-in, focus trap,
 * Esc/backdrop close, title/footer) is unchanged.
 */

import { X } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { useFocusTrap } from "../lib/use-focus-trap.ts"

export function SlideOver({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Render a much wider panel (for a two-column body). Default narrow. */
  wide?: boolean
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  // Drives the slide: mount off-screen, then flip on the next tick so the
  // transition has two distinct transform values to animate between.
  const [shown, setShown] = useState(false)
  useFocusTrap(panelRef, open)

  // Flip to the on-screen position one layout tick after mount.
  useEffect(() => {
    if (!open) {
      setShown(false)
      return
    }
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [open])

  // Move focus into the panel on mount so Tab/Esc land in the drawer
  // immediately (the trap only intercepts keydowns INSIDE the panel).
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  // Esc closes — except while typing in a field, where Esc should leave the
  // field alone (the IssuePeek/BoardPeek pattern).
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return
      const t = event.target as HTMLElement | null
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className={`relative flex h-full flex-col border-l border-line bg-bg shadow-2xl transition-transform duration-200 ease-out motion-reduce:transition-none focus:outline-none ${
          wide ? "w-[920px] max-w-[96vw]" : "w-[640px] max-w-[92vw]"
        } ${shown ? "translate-x-0" : "translate-x-full"}`}
      >
        {title !== undefined && (
          <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
            <div className="min-w-0 flex-1 truncate text-[13px] text-fg">
              {title}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex shrink-0 items-center text-muted transition-colors hover:text-fg"
              aria-label="Close"
              title="Close (Esc)"
            >
              <X size={15} strokeWidth={1.8} />
            </button>
          </header>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {footer !== undefined && (
          <footer className="shrink-0 border-t border-line bg-surface">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}
