import { describe, expect, it } from "vitest"
import { ATTR, type Chunk } from "../../src/tui/panes/terminal/sgr"
import { overlayCursor } from "../../src/tui/panes/terminal/terminal-render"

/** The single chunk carrying the INVERSE attribute — that's the cursor cell. */
function cursorCell(rows: readonly (readonly Chunk[])[], y: number): Chunk | undefined {
  return rows[y]?.find((c) => ((c.attributes ?? 0) & ATTR.INVERSE) !== 0)
}

describe("overlayCursor — cell-column aware", () => {
  it("lands on the right char when the row has wide (CJK) glyphs", () => {
    // "你好x": 你 = cells 0-1, 好 = cells 2-3, x = cell 4. `cursor.x` is a
    // CELL column, so counting code points (你好x = 3) used to drift the
    // cursor left by one column per wide char — this pins the fix.
    const rows = [[{ text: "你好x" } as Chunk]]
    expect(cursorCell(overlayCursor(rows, { x: 0, y: 0 }), 0)?.text).toBe("你")
    expect(cursorCell(overlayCursor(rows, { x: 2, y: 0 }), 0)?.text).toBe("好")
    expect(cursorCell(overlayCursor(rows, { x: 4, y: 0 }), 0)?.text).toBe("x")
  })

  it("a wide char's trailing cell resolves to the char itself", () => {
    const rows = [[{ text: "你好" } as Chunk]]
    // x=1 is 你's second cell, x=3 is 好's second cell.
    expect(cursorCell(overlayCursor(rows, { x: 1, y: 0 }), 0)?.text).toBe("你")
    expect(cursorCell(overlayCursor(rows, { x: 3, y: 0 }), 0)?.text).toBe("好")
  })

  it("keeps the ascii fast path exact and splits the chunk around the cursor", () => {
    const rows = [[{ text: "abc" } as Chunk]]
    const out = overlayCursor(rows, { x: 1, y: 0 })[0]
    expect(out.map((c) => c.text)).toEqual(["a", "b", "c"])
    expect(cursorCell([out], 0)?.text).toBe("b")
  })

  it("past-the-end cursor (blank cell) appends an inverse space", () => {
    const rows = [[{ text: "你" } as Chunk]]
    // 你 spans cells 0-1; x=2 is the empty cell after it.
    const out = overlayCursor(rows, { x: 2, y: 0 })[0]
    expect(out.at(-1)).toEqual({ text: " ", attributes: ATTR.INVERSE })
  })

  it("only overlays the cursor's row", () => {
    const rows = [[{ text: "你" } as Chunk], [{ text: "好" } as Chunk]]
    const out = overlayCursor(rows, { x: 0, y: 1 })
    expect(cursorCell(out, 0)).toBeUndefined()
    expect(cursorCell(out, 1)?.text).toBe("好")
  })

  it("cursor beyond the rendered tail pads to the REAL column (typed spaces)", () => {
    // Typing spaces echoes blank cells a backend may not emit: row renders
    // "ab" while xterm's cursor sits at x=4 (two spaces typed). The overlay
    // must pad to column 4 — appending straight after the text froze the
    // visual cursor at column 2 no matter how many spaces were typed.
    const rows = [[{ text: "ab" } as Chunk]]
    const out = overlayCursor(rows, { x: 4, y: 0 })[0]
    expect(out.map((c) => c.text).join("")).toBe("ab   ")
    expect(out.at(-1)).toEqual({ text: " ", attributes: ATTR.INVERSE })
  })
})
