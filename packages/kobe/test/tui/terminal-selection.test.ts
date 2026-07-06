/**
 * Why this matters: grid selection is the embedded terminal's ONLY copy
 * path (opentui's flow selection breaks over a wholesale-replaced
 * snapshot). These pin the xterm/tmux linear-selection semantics —
 * reading-order normalization, first/middle/last row spans, per-line
 * trailing-space trim — so a drag in any direction copies exactly the
 * cells the highlight showed.
 */

import { describe, expect, it } from "vitest"
import { ATTR, type Chunk } from "../../src/tui/panes/terminal/sgr"
import {
  extractSelection,
  orderRange,
  overlaySelection,
  rowSpan,
} from "../../src/tui/panes/terminal/terminal-selection"

const row = (text: string): readonly Chunk[] => [{ text }]

const ROWS = [row("alpha bravo   "), row("charlie delta "), row("echo          ")]

describe("terminal grid selection", () => {
  it("orderRange normalizes an upward/backward drag into reading order", () => {
    const r = orderRange({ anchor: { row: 2, col: 3 }, head: { row: 0, col: 5 } })
    expect(r.start).toEqual({ row: 0, col: 5 })
    expect(r.end).toEqual({ row: 2, col: 3 })
    const same = orderRange({ anchor: { row: 1, col: 7 }, head: { row: 1, col: 2 } })
    expect(same.start.col).toBe(2)
  })

  it("rowSpan follows linear semantics: first row from startCol, middle whole, last to endCol", () => {
    const range = { anchor: { row: 0, col: 6 }, head: { row: 2, col: 1 } }
    expect(rowSpan(range, 0, 14)).toEqual([6, 14])
    expect(rowSpan(range, 1, 14)).toEqual([0, 14])
    expect(rowSpan(range, 2, 14)).toEqual([0, 2])
    expect(rowSpan(range, 3, 14)).toBeNull()
  })

  it("extractSelection slices by span and trims each line's padding", () => {
    const range = { anchor: { row: 0, col: 6 }, head: { row: 2, col: 1 } }
    expect(extractSelection(ROWS, range)).toBe("bravo\ncharlie delta\nec")
    // Single-row word drag, backwards.
    expect(extractSelection(ROWS, { anchor: { row: 1, col: 6 }, head: { row: 1, col: 0 } })).toBe("charlie")
  })

  it("overlaySelection inverses exactly the selected cells of visible rows", () => {
    const range = { anchor: { row: 1, col: 8 }, head: { row: 1, col: 12 } }
    // Viewport starting at absolute row 1 → the selected row is index 0.
    const out = overlaySelection([ROWS[1]], range, 1, 14)
    const chunks = out[0]
    expect(chunks.map((c) => c.text).join("")).toBe("charlie delta ")
    const inverse = chunks.filter((c) => ((c.attributes ?? 0) & ATTR.INVERSE) !== 0)
    expect(inverse.map((c) => c.text).join("")).toBe("delta")
    // Rows outside the range come back untouched (same reference).
    expect(overlaySelection([ROWS[0]], range, 0, 14)[0]).toBe(ROWS[0])
  })

  it("overlaySelection paints highlight over unpainted padding cells", () => {
    const short = [row("ab")]
    const range = { anchor: { row: 0, col: 0 }, head: { row: 0, col: 5 } }
    const out = overlaySelection(short, range, 0, 10)
    expect(out[0].map((c) => c.text).join("")).toBe("ab    ")
  })
})
