import { describe, expect, test } from "vitest"
import { ATTR, ansi256ToRgb, parseAnsiLine } from "../../src/tui/panes/terminal/sgr"

const ESC = "\x1b["

describe("remaining attribute toggles", () => {
  const cases: Array<[string, number, number]> = [
    ["dim (2)", 2, ATTR.DIM],
    ["blink (5)", 5, ATTR.BLINK],
    ["fast blink (6) maps to BLINK too", 6, ATTR.BLINK],
    ["inverse (7)", 7, ATTR.INVERSE],
    ["hidden (8)", 8, ATTR.HIDDEN],
    ["strikethrough (9)", 9, ATTR.STRIKETHROUGH],
  ]
  for (const [name, code, attr] of cases) {
    test(name, () => {
      const { chunks } = parseAnsiLine(`${ESC}${code}mx${ESC}0m`)
      expect(chunks[0]?.attributes).toBe(attr)
    })
  }
})

describe("per-attribute resets (22-29)", () => {
  test("22 clears BOLD and DIM together, leaving other attrs", () => {
    const { chunks } = parseAnsiLine(`${ESC}1;2;3ma${ESC}22mb`)
    expect(chunks[0]?.attributes).toBe(ATTR.BOLD | ATTR.DIM | ATTR.ITALIC)
    expect(chunks[1]?.attributes).toBe(ATTR.ITALIC)
  })

  const resets: Array<[string, number, number, number]> = [
    ["23 clears ITALIC", 3, 23, ATTR.ITALIC],
    ["24 clears UNDERLINE", 4, 24, ATTR.UNDERLINE],
    ["25 clears BLINK", 5, 25, ATTR.BLINK],
    ["27 clears INVERSE", 7, 27, ATTR.INVERSE],
    ["28 clears HIDDEN", 8, 28, ATTR.HIDDEN],
    ["29 clears STRIKETHROUGH", 9, 29, ATTR.STRIKETHROUGH],
  ]
  for (const [name, set, reset, attr] of resets) {
    test(name, () => {
      const { chunks } = parseAnsiLine(`${ESC}1;${set}ma${ESC}${reset}mb`)
      expect(chunks[0]?.attributes).toBe(ATTR.BOLD | attr)
      expect(chunks[1]?.attributes).toBe(ATTR.BOLD)
    })
  }
})

describe("background color families", () => {
  test("standard bg (40-47) uses the system palette", () => {
    const { chunks } = parseAnsiLine(`${ESC}41mx${ESC}0m`)
    expect(chunks[0]?.bg).toEqual([205, 0, 0])
  })

  test("bright bg (100-107) uses the bright palette rows", () => {
    const { chunks } = parseAnsiLine(`${ESC}101mx${ESC}0m`)
    expect(chunks[0]?.bg).toEqual([255, 0, 0])
  })

  test("49 resets bg to default while fg persists", () => {
    const { chunks } = parseAnsiLine(`${ESC}31;41ma${ESC}49mb`)
    expect(chunks[0]?.bg).toEqual([205, 0, 0])
    expect(chunks[1]?.bg).toBeUndefined()
    expect(chunks[1]?.fg).toEqual([205, 0, 0])
  })

  test("48;5;N picks from the 256 palette; 48;2;R;G;B is true-color", () => {
    const a = parseAnsiLine(`${ESC}48;5;238mx${ESC}0m`).chunks[0]
    expect(a?.bg).toEqual(ansi256ToRgb(238))
    const b = parseAnsiLine(`${ESC}48;2;12;34;56mx${ESC}0m`).chunks[0]
    expect(b?.bg).toEqual([12, 34, 56])
  })
})

describe("ansi256ToRgb ramps", () => {
  test("grayscale ramp (232-255) steps by 10 from #080808", () => {
    expect(ansi256ToRgb(232)).toEqual([8, 8, 8])
    expect(ansi256ToRgb(233)).toEqual([18, 18, 18])
    expect(ansi256ToRgb(255)).toEqual([238, 238, 238])
  })

  test("out-of-range index degrades to black instead of crashing", () => {
    expect(ansi256ToRgb(256)).toEqual([0, 0, 0])
    expect(ansi256ToRgb(9999)).toEqual([0, 0, 0])
  })
})

describe("malformed extended-color escapes recover", () => {
  test("a bare 38 with an unknown sub-mode is skipped, later params still apply", () => {
    const { chunks } = parseAnsiLine(`${ESC}38;9;1mx${ESC}0m`)
    expect(chunks[0]?.text).toBe("x")
    expect(chunks[0]?.fg).toBeUndefined()
  })

  test("a bare 48 with an unknown sub-mode recovers the same way", () => {
    const { chunks } = parseAnsiLine(`${ESC}48;9mx${ESC}0m`)
    expect(chunks[0]?.bg).toBeUndefined()
    expect(chunks[0]?.text).toBe("x")
  })
})

describe("1-byte CSI introducer (0x9b)", () => {
  test("parses \\x9b-introduced SGR the same as ESC-[", () => {
    const { chunks } = parseAnsiLine("\x9b31mx\x9b0m")
    expect(chunks[0]?.text).toBe("x")
    expect(chunks[0]?.fg).toEqual([205, 0, 0])
  })
})
