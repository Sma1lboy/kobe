/**
 * Grid-based selection for the embedded terminal pane — the way real
 * terminal emulators select, replacing opentui's text-flow selection
 * which broke over this pane (the snapshot <text> is replaced wholesale
 * on every PTY frame, so flow anchors were invalidated mid-drag:
 * glitchy highlight, empty extraction).
 *
 * Everything here is pure and cell-addressed: a selection is an anchor
 * and a head in ABSOLUTE snapshot coordinates (row = index into the
 * full snapshot row array, col = terminal column), normalized into
 * per-row spans with linear reading-order semantics (first row from
 * the start column, middle rows whole, last row to the end column) —
 * exactly xterm/tmux selection shape. The component owns the mouse
 * wiring and the copy; `overlaySelection` reuses the cursor overlay's
 * chunk-splitting to paint the highlight, so it survives every frame
 * refresh untouched.
 */

import { charWidth } from "../../../lib/display-width"
import { ATTR, type Chunk } from "./sgr"

export type CellPoint = { readonly row: number; readonly col: number }
export type SelectionRange = { readonly anchor: CellPoint; readonly head: CellPoint }

/** Reading-order normalize: start is the earlier of anchor/head. */
export function orderRange(range: SelectionRange): { start: CellPoint; end: CellPoint } {
  const { anchor, head } = range
  const headFirst = head.row < anchor.row || (head.row === anchor.row && head.col < anchor.col)
  return headFirst ? { start: head, end: anchor } : { start: anchor, end: head }
}

/**
 * The selected column span `[from, to)` of `row`, or null when the row
 * is outside the selection. `width` bounds full-row spans.
 */
export function rowSpan(range: SelectionRange, row: number, width: number): readonly [number, number] | null {
  const { start, end } = orderRange(range)
  if (row < start.row || row > end.row) return null
  const from = row === start.row ? start.col : 0
  const to = row === end.row ? end.col + 1 : width
  return from < to ? [from, to] : null
}

/** Concatenated plain text of one snapshot row. */
function rowText(row: readonly Chunk[]): string {
  let s = ""
  for (const chunk of row) s += chunk.text
  return s
}

/** Terminal-cell width of text, preserving zero-width combining marks. */
function textCells(text: string): number {
  let cells = 0
  for (const ch of text) cells += charWidth(ch.codePointAt(0) as number)
  return cells
}

type CellSlice = { readonly before: string; readonly selected: string; readonly after: string }

/**
 * Split text around a terminal-cell span. A wide glyph is kept whole when
 * either of its two cells intersects the span; zero-width marks stay attached
 * to the preceding glyph instead of becoming independently selectable.
 */
function sliceTextByCells(text: string, from: number, to: number): CellSlice {
  let before = ""
  let selected = ""
  let after = ""
  let col = 0
  let lastPart: keyof CellSlice = "before"

  for (const ch of text) {
    const width = charWidth(ch.codePointAt(0) as number)
    if (width === 0) {
      if (lastPart === "selected") selected += ch
      else if (lastPart === "after") after += ch
      else before += ch
      continue
    }

    const end = col + width
    if (end <= from) {
      before += ch
      lastPart = "before"
    } else if (col >= to) {
      after += ch
      lastPart = "after"
    } else {
      selected += ch
      lastPart = "selected"
    }
    col = end
  }

  return { before, selected, after }
}

/**
 * Extract the selected text: per-row slice by span, trailing whitespace
 * trimmed per line (terminal rows are space-padded to the grid width),
 * lines joined with \n.
 */
export function extractSelection(rows: readonly (readonly Chunk[])[], range: SelectionRange): string {
  const { start, end } = orderRange(range)
  const lines: string[] = []
  for (let r = Math.max(0, start.row); r <= Math.min(rows.length - 1, end.row); r++) {
    const text = rowText(rows[r] ?? [])
    const span = rowSpan(range, r, Math.max(textCells(text), 1))
    if (!span) continue
    lines.push(sliceTextByCells(text, span[0], span[1]).selected.trimEnd())
  }
  return lines.join("\n")
}

/** Re-chunk one row so `[from, to)` renders inverse-video. */
function overlayRowSpan(row: readonly Chunk[], from: number, to: number): Chunk[] {
  const out: Chunk[] = []
  let col = 0
  for (const chunk of row) {
    const start = col
    const end = start + textCells(chunk.text)
    col = end
    if (end <= from || start >= to) {
      out.push(chunk)
      continue
    }
    const { before, selected, after } = sliceTextByCells(chunk.text, from - start, to - start)
    if (before) out.push({ ...chunk, text: before })
    out.push({ ...chunk, text: selected, attributes: (chunk.attributes ?? 0) | ATTR.INVERSE })
    if (after) out.push({ ...chunk, text: after })
  }
  // Selection reaching past the row's painted cells: show the highlight
  // on the padding too, like terminals do.
  if (col < to) out.push({ text: " ".repeat(to - Math.max(col, from)), attributes: ATTR.INVERSE })
  return out
}

/**
 * Paint the selection over VIEWPORT rows. `firstRow` is the absolute
 * snapshot index of `rows[0]` (the viewport start), mapping the
 * absolute-addressed range onto the visible slice.
 */
export function overlaySelection(
  rows: readonly (readonly Chunk[])[],
  range: SelectionRange | null,
  firstRow: number,
  width: number,
): readonly (readonly Chunk[])[] {
  if (!range) return rows
  return rows.map((row, i) => {
    const span = rowSpan(range, firstRow + i, width)
    return span ? overlayRowSpan(row, span[0], span[1]) : row
  })
}
