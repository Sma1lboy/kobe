/**
 * Copy-on-select, GRID-based selection for the embedded terminal pane —
 * React port of the selection half of `tui/panes/terminal/Terminal.tsx`
 * (tmux convention; see `terminal-selection.ts` for why opentui's text-flow
 * selection can't work over this pane). Split out purely to keep
 * `Terminal.tsx` under the file-size cap.
 *
 * Anchor and head live in ABSOLUTE snapshot coordinates so the highlight
 * survives every frame refresh and scrollback move. A ZERO-WIDTH selection
 * (a plain click, before any drag) resolves to `null` — rendering no
 * highlight and, more importantly, keeping `selection` reference-stable
 * across a click so the snapshot content isn't re-pushed for nothing (the
 * whole-pane twitch-on-click the Solid original called out).
 *
 * `isDragging` is a plain ref, not state: it flips on every mouse-move
 * during a drag, and mirroring that into React state would re-render the
 * pane on every pixel of drag motion for no visible benefit.
 */

import type { BoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useMemo, useRef, useState } from "react"
import { copyTextToSystemClipboard } from "../../../tui/lib/clipboard-copy"
import type { TerminalRow } from "../../../tui/panes/terminal/pty"
import { type CellPoint, type SelectionRange, extractSelection } from "../../../tui/panes/terminal/terminal-selection"

export type { CellPoint, SelectionRange } from "../../../tui/panes/terminal/terminal-selection"

export interface UseTerminalSelectionOpts {
  bodyEl: BoxRenderable | null
  bodyGeometry: { cols: number; rows: number } | null
  bodyRows: number
  /** Absolute snapshot row index of the first VISIBLE row (viewport start). */
  visibleRangeStart: number
  snapshot: readonly TerminalRow[]
}

export interface UseTerminalSelectionResult {
  selection: SelectionRange | null
  /** Map a mouse event's screen coords to absolute (row, col) snapshot coordinates. */
  cellFromEvent: (evt: { x?: number; y?: number }) => CellPoint | null
  beginSelection: (cell: CellPoint) => void
  updateSelectionHead: (cell: CellPoint) => void
  isDragging: () => boolean
  endDragging: () => void
  clearSelection: () => void
  copySelection: () => void
}

export function useTerminalSelection(opts: UseTerminalSelectionOpts): UseTerminalSelectionResult {
  const [selAnchor, setSelAnchor] = useState<CellPoint | null>(null)
  const [selHead, setSelHead] = useState<CellPoint | null>(null)
  const draggingRef = useRef(false)
  const renderer = useRenderer()

  const selection = useMemo<SelectionRange | null>(() => {
    if (!selAnchor || !selHead) return null
    if (selAnchor.row === selHead.row && selAnchor.col === selHead.col) return null
    return { anchor: selAnchor, head: selHead }
  }, [selAnchor, selHead])

  const cellFromEvent = (evt: { x?: number; y?: number }): CellPoint | null => {
    const { bodyEl: body, bodyGeometry: geometry, bodyRows, visibleRangeStart } = opts
    if (!body || !geometry) return null
    const col = Math.min(geometry.cols - 1, Math.max(0, (evt.x ?? 0) - body.screenX))
    const viewRow = Math.min(bodyRows - 1, Math.max(0, (evt.y ?? 0) - body.screenY))
    return { row: visibleRangeStart + viewRow, col }
  }

  const beginSelection = (cell: CellPoint): void => {
    draggingRef.current = true
    setSelAnchor(cell)
    setSelHead(cell)
  }

  const updateSelectionHead = (cell: CellPoint): void => {
    if (!draggingRef.current) return
    setSelHead(cell)
  }

  const copySelection = (): void => {
    if (!selection) return
    const text = extractSelection(opts.snapshot, selection)
    if (text.trim().length > 0) copyTextToSystemClipboard(text, (payload) => renderer?.copyToClipboardOSC52(payload))
  }

  return {
    selection,
    cellFromEvent,
    beginSelection,
    updateSelectionHead,
    isDragging: () => draggingRef.current,
    endDragging: () => {
      draggingRef.current = false
    },
    clearSelection: () => {
      setSelAnchor(null)
      setSelHead(null)
    },
    copySelection,
  }
}
