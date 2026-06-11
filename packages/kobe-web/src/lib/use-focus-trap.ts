/**
 * useFocusTrap — keep Tab focus inside a modal container and restore focus to
 * wherever it was when the modal closes. Deliberately does NOT steal initial
 * focus on mount: each modal keeps its own initial-focus logic (the command
 * palette focuses its query, the confirm dialog focuses its confirm button),
 * and this only adds the trap + restore. a11y polish for the dashboard's
 * dialogs.
 */

import { type RefObject, useEffect } from "react"

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",")

/**
 * @param active — when false the trap is inert. Pass the modal's open flag for
 *   an always-mounted modal that returns null while closed (the dialog element
 *   doesn't exist until `active` flips true, so the effect must re-run then).
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active = true,
): void {
  useEffect(() => {
    if (!active) return
    const el = ref.current
    if (!el) return
    const previouslyFocused = document.activeElement as HTMLElement | null

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return
      const items = Array.from(
        el.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter(
        // Visible + tabbable (offsetParent is null for display:none).
        (f) => f.offsetParent !== null || f === document.activeElement,
      )
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      // Wrap at the edges. If focus somehow escaped the modal, pull it back in.
      if (event.shiftKey) {
        if (active === first || !el.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !el.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }

    el.addEventListener("keydown", onKey)
    return () => {
      el.removeEventListener("keydown", onKey)
      // Restore focus to the opener (best-effort — it may be gone).
      previouslyFocused?.focus?.()
    }
  }, [ref, active])
}
