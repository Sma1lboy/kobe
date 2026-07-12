import { describe, expect, it } from "vitest"
import { xtermLineMatchesChunks, xtermLineToChunks } from "../../src/tui/panes/terminal/xterm-chunks"

/**
 * Minimal default-style xterm cell — blank cells are what a typed space
 * echoes as (chars " ", every attribute/color default).
 */
function cell(chars: string) {
  return {
    getChars: () => chars,
    getWidth: () => 1,
    isFgDefault: () => true,
    isBgDefault: () => true,
    isFgPalette: () => false,
    isBgPalette: () => false,
    isFgRGB: () => false,
    isBgRGB: () => false,
    getFgColorMode: () => 0,
    getBgColorMode: () => 0,
    getFgColor: () => 0,
    getBgColor: () => 0,
    isAttributeDefault: () => true,
    isBold: () => false,
    isDim: () => false,
    isItalic: () => false,
    isUnderline: () => false,
    isBlink: () => false,
    isInverse: () => false,
    isInvisible: () => false,
    isStrikethrough: () => false,
  }
}

function line(text: string, length = 40) {
  return {
    length,
    getCell: (index: number) => cell(index < text.length ? (text[index] as string) : ""),
  }
}

/**
 * A styled cell: default-style except a bold + RGB-fg run, so adjacent
 * styled cells coalesce into one chunk and an interior blank breaks the run.
 */
function styledCell(chars: string) {
  return {
    ...cell(chars),
    isFgDefault: () => false,
    isFgRGB: () => true,
    getFgColorMode: () => 3 << 24,
    getFgColor: () => 0xff8800,
    isAttributeDefault: () => false,
    isBold: () => true,
  }
}

describe("xtermLineToChunks — minLast keeps the cursor's blank tail", () => {
  it("trims trailing blanks without minLast", () => {
    expect(
      xtermLineToChunks(line("ab  "))
        .map((c) => c.text)
        .join(""),
    ).toBe("ab")
  })

  it("minLast survives the visible-cell scan (typed-space cursor tail)", () => {
    // "ab" + two typed spaces, cursor at x=4 → minLast=3 must force cells
    // 0..3 out even though the last VISIBLE cell is 'b' at x=1. The old
    // `last = x` let 'a' clobber the seed, so the space cells vanished and
    // the drawn cursor froze at end-of-text.
    expect(
      xtermLineToChunks(line("ab  "), 3)
        .map((c) => c.text)
        .join(""),
    ).toBe("ab  ")
  })

  it("minLast is clamped to the line length", () => {
    expect(
      xtermLineToChunks(line("ab", 3), 99)
        .map((c) => c.text)
        .join(""),
    ).toBe("ab ")
  })
})

describe("xtermLineMatchesChunks — allocation-free semantic check", () => {
  it("matches the converter across text, cursor padding, and styles", () => {
    const plain = line("ab  ")
    expect(xtermLineMatchesChunks(plain, xtermLineToChunks(plain))).toBe(true)
    expect(xtermLineMatchesChunks(plain, xtermLineToChunks(plain, 3), 3)).toBe(true)
    expect(xtermLineMatchesChunks(plain, xtermLineToChunks(plain), 3)).toBe(false)

    const cells = [styledCell("A"), styledCell("B"), cell(" "), styledCell("C")]
    const styled = {
      length: cells.length,
      getCell: (index: number) => cells[index],
    }
    const chunks = xtermLineToChunks(styled)
    expect(xtermLineMatchesChunks(styled, chunks)).toBe(true)
    expect(xtermLineMatchesChunks(line("AB C", 4), chunks)).toBe(false)
  })
})

describe("xtermLineToChunks — scratch cell reuse", () => {
  /**
   * xterm-faithful line: `getCell(x, scratch)` loads the cell's data into
   * `scratch` and returns *that same reference* (zero allocation), exactly
   * like `@xterm/headless`. Only the no-arg form constructs a fresh cell —
   * `construct` counts those, standing in for `new CellData()`. `getChars`
   * counts per-cell reads so we can prove work is unchanged.
   */
  function countingLine(text: string, length = 180) {
    let construct = 0
    let getChars = 0
    const dataAt = (index: number) => {
      const c = cell(index < text.length ? (text[index] as string) : "")
      const origGetChars = c.getChars
      c.getChars = () => {
        getChars++
        return origGetChars()
      }
      return c
    }
    return {
      counts: () => ({ construct, getChars }),
      line: {
        length,
        getCell(index: number, scratch?: ReturnType<typeof cell>) {
          if (scratch) {
            // Reuse: copy into the caller's scratch, allocate nothing.
            Object.assign(scratch, dataAt(index))
            return scratch
          }
          construct++
          return dataAt(index)
        },
      },
    }
  }

  it("allocates zero fresh cells per line and reads getChars unchanged", () => {
    // Warm the module scratch first (its lazy seed is a one-time cost, not
    // per-line), then measure a clean 180-col line.
    xtermLineToChunks(countingLine("warmup").line)

    const first = countingLine("hello world")
    xtermLineToChunks(first.line)
    const a = first.counts()
    expect(a.construct).toBe(0)

    // getChars count is identical for an identical line before/after — the
    // scratch changes allocation only, never the amount of work.
    const second = countingLine("hello world")
    xtermLineToChunks(second.line)
    const b = second.counts()
    expect(b.construct).toBe(0)
    expect(b.getChars).toBe(a.getChars)
    expect(b.getChars).toBeGreaterThan(0)
  })
})

describe("xtermLineToChunks — run boundaries survive scratch reuse", () => {
  it("keeps an interior blank between two styled runs", () => {
    // "AB" (styled) + " " (default blank) + "CD" (styled): scratch reuse must
    // not bleed the styled attributes across the blank, so this is three
    // chunks — styled / blank / styled — not one coalesced run.
    const cells = [styledCell("A"), styledCell("B"), cell(" "), styledCell("C"), styledCell("D")]
    const line = {
      length: 5,
      getCell: (index: number, scratch?: ReturnType<typeof cell>) => {
        const src = cells[index] ?? cell("")
        if (scratch) {
          Object.assign(scratch, src)
          return scratch
        }
        return src
      },
    }
    const chunks = xtermLineToChunks(line)
    expect(chunks.map((c) => c.text)).toEqual(["AB", " ", "CD"])
    expect(chunks[0]?.attributes).toBe(chunks[2]?.attributes)
    expect(chunks[1]?.attributes).toBeUndefined()
  })
})
