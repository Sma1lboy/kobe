/**
 * SGR parser — the attribute families terminal-sgr.test.ts leaves out:
 * the remaining toggles (dim/blink/inverse/hidden/strike), every per-attr
 * RESET code (22-29), the bright/standard bg rows, the grayscale ramp,
 * malformed extended-color recovery, and the 1-byte CSI introducer.
 * Same import discipline as the sibling file: nothing here may pull in
 * @opentui/core.
 */

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
      // set attr + bold, then reset only the attr — bold must survive.
      const { chunks } = parseAnsiLine(`${ESC}1;${set}ma${ESC}${reset}mb`)
      expect(chunks[0]?.attributes).toBe(ATTR.BOLD | attr)
      expect(chunks[1]?.attributes).toBe(ATTR.BOLD)
    })
  }
})

describe("background color families", () => {
  test("standard bg (40-47) uses the system palette", () => {
    const { chunks } = parseAnsiLine(`${ESC}41mx${ESC}0m`)
    expect(chunks[0]?.bg).toEqual([247, 118, 142])
  })

  test("bright bg (100-107) uses the bright palette rows", () => {
    const { chunks } = parseAnsiLine(`${ESC}101mx${ESC}0m`)
    expect(chunks[0]?.bg).toEqual([255, 137, 157])
  })

  test("49 resets bg to default while fg persists", () => {
    const { chunks } = parseAnsiLine(`${ESC}31;41ma${ESC}49mb`)
    expect(chunks[0]?.bg).toEqual([247, 118, 142])
    expect(chunks[1]?.bg).toBeUndefined()
    expect(chunks[1]?.fg).toEqual([247, 118, 142])
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
    // 38;9 is not a valid introducer form; the parser must skip it and
    // still apply the bold that follows.
    const { chunks } = parseAnsiLine(`${ESC}38;9;1mx${ESC}0m`)
    expect(chunks[0]?.text).toBe("x")
    // fg untouched by the malformed introducer
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
    expect(chunks[0]?.fg).toEqual([247, 118, 142])
  })
})

describe("OSC 8 hyperlinks", () => {
  const URL = "https://example.com/s/quill-landing"

  // @xterm/headless underlines linked cells, so the production cell→chunk path
  // reports ATTR.UNDERLINE for a link. This fallback parser used to DROP the
  // OSC entirely, which made the mock pane render links unlike the real pane.
  test("underlines the linked run and stops at the close (BEL-terminated)", () => {
    const { chunks } = parseAnsiLine(`pre \x1b]8;;${URL}\x07${URL}\x1b]8;;\x07 (round 2)`)
    expect(chunks.map((c) => c.text)).toEqual(["pre ", URL, " (round 2)"])
    expect(chunks[0]?.attributes ?? 0).toBe(0)
    expect(chunks[1]?.attributes).toBe(ATTR.UNDERLINE)
    expect(chunks[2]?.attributes ?? 0).toBe(0)
  })

  test("handles the ST-terminated form identically", () => {
    const { chunks } = parseAnsiLine(`a\x1b]8;;${URL}\x1b\\L\x1b]8;;\x1b\\b`)
    expect(chunks.map((c) => c.text)).toEqual(["a", "L", "b"])
    expect(chunks[1]?.attributes).toBe(ATTR.UNDERLINE)
    expect(chunks[2]?.attributes ?? 0).toBe(0)
  })

  test("keeps SGR colors set inside the link and clears only the underline", () => {
    // claude-code emits the link as OSC8-open + chalk.blue + OSC8-close.
    const { chunks } = parseAnsiLine(`\x1b]8;;${URL}\x07\x1b[34m${URL}\x1b[39m\x1b]8;;\x07 tail`)
    const link = chunks.find((c) => c.text === URL)
    expect(link?.attributes).toBe(ATTR.UNDERLINE)
    expect(link?.fg).toEqual([122, 162, 247])
    expect(chunks.at(-1)?.text).toBe(" tail")
    expect(chunks.at(-1)?.attributes ?? 0).toBe(0)
    expect(chunks.at(-1)?.fg).toBeUndefined()
  })

  test("a link left open carries the underline to the end of the line", () => {
    const { chunks, endStyle } = parseAnsiLine(`a\x1b]8;;${URL}\x07tail`)
    expect(chunks.at(-1)?.attributes).toBe(ATTR.UNDERLINE)
    expect(endStyle.attributes & ATTR.UNDERLINE).toBe(ATTR.UNDERLINE)
  })
})
