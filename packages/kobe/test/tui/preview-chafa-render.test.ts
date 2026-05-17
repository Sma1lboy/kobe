/**
 * Unit tests for the chafa ANSI parser. The chafa subprocess and the
 * ffmpeg-driven GIF frame extractor shell out to binaries and aren't
 * covered here; they're exercised end-to-end via the preview pane.
 */
import { parseChafaOutput } from "@/tui/panes/preview/chafa-render"
import { describe, expect, it } from "vitest"

function sgr(...codes: number[]): string {
  return `\x1b[${codes.join(";")}m`
}

describe("parseChafaOutput", () => {
  it("parses a single colored cell", () => {
    const buf = Buffer.from(`${sgr(38, 2, 255, 0, 0, 48, 2, 0, 0, 255)}X${sgr(0)}\n`)
    const grid = parseChafaOutput(buf)
    expect(grid.rows).toBe(1)
    expect(grid.cols).toBe(1)
    expect(grid.cells[0][0]).toEqual({
      char: "X",
      fg: { r: 255, g: 0, b: 0 },
      bg: { r: 0, g: 0, b: 255 },
    })
  })

  it("handles reverse video by swapping fg ↔ bg", () => {
    // chafa emits `\x1b[7m\x1b[38;2;R;G;Bm <space> \x1b[0m` for solid
    // color cells — the bg fills the cell after the swap.
    const buf = Buffer.from(`${sgr(0)}${sgr(7)}${sgr(38, 2, 200, 100, 50)} ${sgr(0)}\n`)
    const grid = parseChafaOutput(buf)
    const cell = grid.cells[0][0]
    expect(cell.bg).toEqual({ r: 200, g: 100, b: 50 })
  })

  it("preserves multibyte UTF-8 glyphs as a single cell", () => {
    // U+2580 ▀ in UTF-8 is 0xe2 0x96 0x80.
    const upper = Buffer.from([0xe2, 0x96, 0x80]).toString("utf8")
    const buf = Buffer.concat([
      Buffer.from(sgr(38, 2, 10, 20, 30, 48, 2, 40, 50, 60)),
      Buffer.from(upper, "utf8"),
      Buffer.from(`${sgr(0)}\n`),
    ])
    const grid = parseChafaOutput(buf)
    expect(grid.cols).toBe(1)
    expect(grid.cells[0][0].char).toBe(upper)
  })

  it("splits multi-row output on newlines", () => {
    const cell = (r: number, g: number, b: number, ch: string) => `${sgr(38, 2, r, g, b, 48, 2, 0, 0, 0)}${ch}${sgr(0)}`
    const buf = Buffer.from(`${cell(1, 1, 1, "A")}${cell(2, 2, 2, "B")}\n${cell(3, 3, 3, "C")}\n`)
    const grid = parseChafaOutput(buf)
    expect(grid.rows).toBe(2)
    expect(grid.cells[0].map((c) => c.char)).toEqual(["A", "B"])
    expect(grid.cells[1].map((c) => c.char)).toEqual(["C"])
  })

  it("computes cols as the widest row", () => {
    const cell = (ch: string) => `${sgr(38, 2, 1, 2, 3, 48, 2, 4, 5, 6)}${ch}${sgr(0)}`
    const buf = Buffer.from(`${cell("a")}${cell("b")}${cell("c")}\n${cell("d")}\n`)
    expect(parseChafaOutput(buf).cols).toBe(3)
  })

  it("resets colors on SGR 0", () => {
    const buf = Buffer.from(
      `${sgr(38, 2, 1, 2, 3, 48, 2, 4, 5, 6)}A${sgr(0)}B${sgr(38, 2, 9, 9, 9, 48, 2, 7, 7, 7)}C${sgr(0)}\n`,
    )
    const grid = parseChafaOutput(buf)
    expect(grid.cells[0][0].fg).toEqual({ r: 1, g: 2, b: 3 })
    expect(grid.cells[0][1].fg).toEqual({ r: 0, g: 0, b: 0 })
    expect(grid.cells[0][2].fg).toEqual({ r: 9, g: 9, b: 9 })
  })
})
