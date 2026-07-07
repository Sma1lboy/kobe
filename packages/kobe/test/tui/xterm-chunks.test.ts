import { describe, expect, it } from "vitest"
import { xtermLineToChunks } from "../../src/tui/panes/terminal/xterm-chunks"

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
