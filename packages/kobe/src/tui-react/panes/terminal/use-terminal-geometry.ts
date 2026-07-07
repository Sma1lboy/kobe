/**
 * Body-box geometry measurement for the embedded terminal pane — split out
 * of `Terminal.tsx` (React port of the measurement half of the Solid
 * original) purely to keep the component under the file-size cap; the
 * resize-push-to-pty and host-cursor-anchor effects stay in `Terminal.tsx`
 * because they need the PTY handle and the computed viewport cursor, which
 * only exist after this hook's `bodyGeometry` has fed `useTerminalPty`.
 *
 * Measures the rendered body box (before spawning the PTY) so a fresh pane
 * boots at its real size instead of the 80x24 default — booting small
 * then immediately resizing makes zsh/starship-style prompts redraw into
 * stray standalone lines.
 *
 * `bodyEl` MUST be React state (not a plain ref) — the measurement effect
 * needs to re-run the instant the box ref is attached, mirroring the
 * Solid original's `bodyRef()` signal read (tracked, so setting the ref
 * re-fires the effect on first layout). A plain `useRef` would silently
 * skip that first measurement.
 */

import type { BoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useState } from "react"

export interface UseTerminalGeometryResult {
  bodyEl: BoxRenderable | null
  setBodyEl: (el: BoxRenderable | null) => void
  bodyRows: number
  bodyGeometry: { cols: number; rows: number } | null
  bumpGeomTick: () => void
  /** Live host-terminal dims — re-exported so callers can key their own effects off resize ticks without a second subscription. */
  dims: { width: number; height: number }
  /** Layout-tick bumped by the body box's `onSizeChange` — see header. */
  geomTick: number
}

export function useTerminalGeometry(): UseTerminalGeometryResult {
  const [bodyEl, setBodyEl] = useState<BoxRenderable | null>(null)
  const [bodyRows, setBodyRows] = useState(4)
  const [bodyGeometry, setBodyGeometry] = useState<{ cols: number; rows: number } | null>(null)
  const dims = useTerminalDimensions()

  // Layout-tick — bumped by the body box's real `onSizeChange` (fires once
  // Yoga computes a new size) so this hook catches up with layout changes
  // that have no React state of their own (a splitter drag resizes the
  // pane downstream of the state that mutates it).
  const [geomTick, setGeomTick] = useState(0)
  const bumpGeomTick = useCallback((): void => {
    setGeomTick((n) => (n + 1) & 0xff)
  }, [])

  useEffect(() => {
    // Dependency-only invalidation keys: dims (host terminal resize) and
    // geomTick (splitter-drag `onSizeChange`) re-run this measurement
    // without being read directly — screenX/width/height are non-reactive
    // geometry, read imperatively off `bodyEl` below.
    void dims
    void geomTick
    if (!bodyEl) return
    // Pre-layout guard: before Yoga's first pass the box reports 0 (or
    // junk) — flooring that into a "plausible" 20x4 and pushing it to an
    // already-running PTY forced the engine CLI to redraw tiny.
    if (bodyEl.width <= 0 || bodyEl.height <= 0) return
    const cols = Math.max(20, bodyEl.width)
    const rows = Math.max(4, bodyEl.height)
    setBodyRows(rows)
    setBodyGeometry((cur) => (cur && cur.cols === cols && cur.rows === rows ? cur : { cols, rows }))
  }, [bodyEl, dims, geomTick])

  return { bodyEl, setBodyEl, bodyRows, bodyGeometry, bumpGeomTick, dims, geomTick }
}
