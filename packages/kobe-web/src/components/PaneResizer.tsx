/**
 * Draggable pane-width control: usePaneWidth owns a persisted width, and
 * PaneResizer is the thin divider that drives it. `dir` maps pointer travel
 * to growth — +1 for a pane left of its divider (sidebar), -1 for a pane
 * right of it (trace panel).
 */

import { useCallback, useRef, useState } from "react"

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export function usePaneWidth(
  storageKey: string,
  fallback: number,
  min: number,
  max: number,
  dir: 1 | -1,
): [number, (e: React.PointerEvent) => void] {
  const [width, setWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem(storageKey))
    return clamp(Number.isFinite(stored) && stored > 0 ? stored : fallback, min, max)
  })
  const widthRef = useRef(width)

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const x0 = e.clientX
      const w0 = widthRef.current
      const move = (ev: PointerEvent) => {
        const next = clamp(w0 + dir * (ev.clientX - x0), min, max)
        widthRef.current = next
        setWidth(next)
      }
      const up = () => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
        document.body.style.cursor = ""
        window.localStorage.setItem(storageKey, String(widthRef.current))
      }
      document.body.style.cursor = "col-resize"
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
    },
    [storageKey, min, max, dir],
  )

  return [width, startDrag]
}

export function PaneResizer({
  onPointerDown,
  label,
}: {
  onPointerDown: (e: React.PointerEvent) => void
  label: string
}) {
  return (
    // Pointer-only affordance (drag to resize); panes stay reachable without it.
    <div
      aria-hidden="true"
      title={label}
      onPointerDown={onPointerDown}
      className="group relative z-10 -mx-0.5 w-1 shrink-0 cursor-col-resize"
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-primary/60 group-active:bg-primary" />
    </div>
  )
}
