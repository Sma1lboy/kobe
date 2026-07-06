import { type RefObject, useEffect } from "react"

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",")

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
      ).filter((f) => f.offsetParent !== null || f === document.activeElement)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
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
      previouslyFocused?.focus?.()
    }
  }, [ref, active])
}
