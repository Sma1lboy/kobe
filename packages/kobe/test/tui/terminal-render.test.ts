import { describe, expect, it } from "vitest"
import { ATTR, type Chunk, type RGB } from "../../src/tui/panes/terminal/sgr"
import { overlayCursor, sealRowEndAttributes } from "../../src/tui/panes/terminal/terminal-render"

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

describe("sealRowEndAttributes — opentui row-end attribute leak workaround", () => {
  const FG: RGB = [255, 255, 255]
  const BG: RGB = [0, 0, 0]

  it("clears attributes on the last cell of a full-width row", () => {
    // A styled run reaching the final column is what makes opentui skip its
    // per-row reset, bleeding the attribute into the whole rest of the frame.
    const rows = [[{ text: "ab" } as Chunk, { text: "cde", attributes: ATTR.UNDERLINE } as Chunk]]
    const out = sealRowEndAttributes(rows, 5, FG, BG)[0] as readonly Chunk[]
    expect(out.map((c) => c.text).join("")).toBe("abcde")
    // decoration survives everywhere but the sealed final cell
    expect(out.at(-2)?.attributes).toBe(ATTR.UNDERLINE)
    expect(out.at(-1)?.attributes ?? 0).toBe(0)
  })

  it("replays INVERSE as swapped colors so a last-column cursor stays visible", () => {
    const rows = [[{ text: "abcd" } as Chunk, { text: "e", attributes: ATTR.INVERSE } as Chunk]]
    const out = sealRowEndAttributes(rows, 5, FG, BG)[0] as readonly Chunk[]
    const sealed = out.at(-1) as Chunk
    expect(sealed.attributes ?? 0).toBe(0)
    expect(sealed.fg).toEqual(BG)
    expect(sealed.bg).toEqual(FG)
  })

  it("leaves short rows untouched — their run is followed by a normal reset", () => {
    const rows = [[{ text: "ab", attributes: ATTR.UNDERLINE } as Chunk]]
    expect(sealRowEndAttributes(rows, 40, FG, BG)[0]).toBe(rows[0])
  })

  it("counts wide glyphs by CELL width when deciding a row is full", () => {
    // "你好" is 2 chunks-worth of text but FOUR cells: a cols=4 row is full.
    const rows = [[{ text: "你好", attributes: ATTR.UNDERLINE } as Chunk]]
    const out = sealRowEndAttributes(rows, 4, FG, BG)[0] as readonly Chunk[]
    expect(out.map((c) => c.text).join("")).toBe("你好")
    expect(out.at(-1)?.attributes ?? 0).toBe(0)
    // ...and the same row is left alone in a wider terminal.
    expect(sealRowEndAttributes(rows, 10, FG, BG)[0]).toBe(rows[0])
  })

  it("seals the last VISIBLE cell when the row is wider than the pane", () => {
    // Unwrapped backends hand over whole logical lines, so a row can exceed
    // `cols`. Sealing the last CHUNK missed this: the underlined URL still
    // owned the last visible column while the clipped " (round 2)" tail was
    // never painted, and the leak survived at narrow widths.
    const rows = [
      [{ text: "ab" } as Chunk, { text: "cdef", attributes: ATTR.UNDERLINE } as Chunk, { text: " tail" } as Chunk],
    ]
    const out = sealRowEndAttributes(rows, 5, FG, BG)[0] as readonly Chunk[]
    // column 4 (0-indexed) is "c d e f"[2] = "e"
    expect(out.map((c) => c.text).join("")).toBe("abcdef tail")
    const sealed = out.find((c) => c.text === "e") as Chunk
    expect(sealed.attributes ?? 0).toBe(0)
    expect(sealed.fg).toEqual(FG)
    // decoration before and after the sealed cell is untouched
    expect(out.find((c) => c.text === "cd")?.attributes).toBe(ATTR.UNDERLINE)
    expect(out.find((c) => c.text === "f")?.attributes).toBe(ATTR.UNDERLINE)
  })

  it("seals a wide glyph that straddles the last visible column", () => {
    const rows = [[{ text: "a" } as Chunk, { text: "你好", attributes: ATTR.UNDERLINE } as Chunk]]
    // cols=4: "a"=col0, 你=cols1-2, 好 straddles col3 (the last visible one)
    const out = sealRowEndAttributes(rows, 4, FG, BG)[0] as readonly Chunk[]
    expect(out.map((c) => c.text).join("")).toBe("a你好")
    expect(out.find((c) => c.text === "好")?.attributes ?? 0).toBe(0)
    expect(out.find((c) => c.text === "你")?.attributes).toBe(ATTR.UNDERLINE)
  })

  it("is a no-op for unstyled rows", () => {
    const rows = [[{ text: "abcde" } as Chunk]]
    expect(sealRowEndAttributes(rows, 5, FG, BG)[0]).toBe(rows[0])
  })
})
