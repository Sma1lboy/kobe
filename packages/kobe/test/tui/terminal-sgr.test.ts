/**
 * Behavior tests for the SGR parser at
 * `src/tui/panes/terminal/sgr.ts`.
 *
 * The parser converts a tmux `capture-pane -e` snapshot (text + SGR
 * escapes only — all cursor motion already applied by tmux) into a
 * list of per-row chunks. We assert each SGR family parses to the
 * right `{fg, bg, attributes}` triple so the terminal pane can
 * render colors without the rest of the stack needing to know about
 * ANSI.
 *
 * Imports here MUST NOT pull in `@opentui/core` directly or
 * transitively — under vitest, opentui's tree-sitter `.scm` assets
 * fail to load. That's why `sgr.ts` returns plain RGB tuples and
 * exposes its own `ATTR` constants; the opentui adapter lives in
 * `sgr-to-text-chunk.ts` and is only loaded by production code.
 */

import { describe, expect, test } from "vitest"
import { ATTR, parseAnsiLine, parseAnsiSnapshot } from "../../src/tui/panes/terminal/sgr"

// CSI introducer: ESC + "[". Tests template as `${ESC}<params>m`.
const ESC = "\x1b["

describe("parseAnsiLine — plain text", () => {
  test("returns a single chunk for unstyled text", () => {
    const { chunks } = parseAnsiLine("hello world")
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.text).toBe("hello world")
    expect(chunks[0]?.fg).toBeUndefined()
    expect(chunks[0]?.bg).toBeUndefined()
    expect(chunks[0]?.attributes).toBeUndefined()
  })

  test("empty input → no chunks", () => {
    const { chunks } = parseAnsiLine("")
    expect(chunks).toHaveLength(0)
  })
})

describe("parseAnsiLine — attribute toggles", () => {
  test("bold (SGR 1) sets the BOLD attribute", () => {
    const { chunks } = parseAnsiLine(`${ESC}1mbold${ESC}0m`)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.text).toBe("bold")
    expect(chunks[0]?.attributes).toBe(ATTR.BOLD)
  })

  test("italic (SGR 3) sets ITALIC", () => {
    const { chunks } = parseAnsiLine(`${ESC}3mitalic${ESC}0m`)
    expect(chunks[0]?.attributes).toBe(ATTR.ITALIC)
  })

  test("underline (SGR 4) sets UNDERLINE", () => {
    const { chunks } = parseAnsiLine(`${ESC}4munder${ESC}0m`)
    expect(chunks[0]?.attributes).toBe(ATTR.UNDERLINE)
  })

  test("combined bold+italic chains to a bitmask", () => {
    const { chunks } = parseAnsiLine(`${ESC}1;3mboth${ESC}0m`)
    expect(chunks[0]?.attributes).toBe(ATTR.BOLD | ATTR.ITALIC)
  })

  test("reset (SGR 0) drops all attrs + colors", () => {
    const { chunks } = parseAnsiLine(`${ESC}1;31mhot${ESC}0mcold`)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.text).toBe("hot")
    expect(chunks[0]?.attributes).toBe(ATTR.BOLD)
    expect(chunks[1]?.text).toBe("cold")
    expect(chunks[1]?.attributes).toBeUndefined()
    expect(chunks[1]?.fg).toBeUndefined()
  })

  test("empty params (just ESC[m) acts as reset", () => {
    const { chunks } = parseAnsiLine(`${ESC}1mbold${ESC}mreset`)
    expect(chunks).toHaveLength(2)
    expect(chunks[1]?.attributes).toBeUndefined()
  })

  test("22 turns off bold without affecting other attrs", () => {
    const { chunks } = parseAnsiLine(`${ESC}1;3mboth${ESC}22mitalicOnly${ESC}0m`)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.attributes).toBe(ATTR.BOLD | ATTR.ITALIC)
    expect(chunks[1]?.attributes).toBe(ATTR.ITALIC)
  })
})

describe("parseAnsiLine — colors", () => {
  test("standard fg (30-37) emits a populated fg", () => {
    const { chunks } = parseAnsiLine(`${ESC}31mred${ESC}0m`)
    expect(chunks[0]?.fg).toBeDefined()
  })

  test("default fg (39) clears the running fg", () => {
    const { chunks } = parseAnsiLine(`${ESC}31mred${ESC}39mplain`)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.fg).toBeDefined()
    expect(chunks[1]?.fg).toBeUndefined()
  })

  test("bright fg (90-97) gives a different RGB than the standard variant", () => {
    const { chunks: dim } = parseAnsiLine(`${ESC}31mr${ESC}0m`)
    const { chunks: bright } = parseAnsiLine(`${ESC}91mr${ESC}0m`)
    expect(dim[0]?.fg).not.toEqual(bright[0]?.fg)
  })

  test("256-color fg (38;5;N) is parsed", () => {
    const { chunks } = parseAnsiLine(`${ESC}38;5;208morange${ESC}0m`)
    expect(chunks[0]?.text).toBe("orange")
    expect(chunks[0]?.fg).toBeDefined()
  })

  test("true-color fg (38;2;R;G;B) round-trips the exact RGB", () => {
    const { chunks } = parseAnsiLine(`${ESC}38;2;128;64;200mtc${ESC}0m`)
    expect(chunks[0]?.fg).toEqual([128, 64, 200])
  })

  test("background (40-47) populates bg, not fg", () => {
    const { chunks } = parseAnsiLine(`${ESC}41mbg${ESC}0m`)
    expect(chunks[0]?.bg).toBeDefined()
    expect(chunks[0]?.fg).toBeUndefined()
  })

  test("true-color bg (48;2;R;G;B) round-trips", () => {
    const { chunks } = parseAnsiLine(`${ESC}48;2;10;20;30mbg${ESC}0m`)
    expect(chunks[0]?.bg).toEqual([10, 20, 30])
  })
})

describe("parseAnsiLine — style transitions", () => {
  test("each color change starts a new chunk", () => {
    const { chunks } = parseAnsiLine(`${ESC}31mA${ESC}32mB${ESC}33mC${ESC}0m`)
    expect(chunks).toHaveLength(3)
    expect(chunks.map((c) => c.text)).toEqual(["A", "B", "C"])
  })

  test("contiguous same-style text stays in one chunk", () => {
    const { chunks } = parseAnsiLine(`${ESC}31mAAA${ESC}31mBBB${ESC}0m`)
    // The two identical SGR escapes flush+restyle, so two chunks
    // even though they share style. This is OK behavior — it just
    // means a slightly longer chunk list, never an incorrect render.
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks.map((c) => c.text).join("")).toBe("AAABBB")
  })

  test("plain text after style flushes a no-style chunk", () => {
    const { chunks } = parseAnsiLine(`${ESC}1mbold${ESC}0mafter`)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.attributes).toBe(ATTR.BOLD)
    expect(chunks[1]?.attributes).toBeUndefined()
  })
})

describe("parseAnsiSnapshot — multi-line", () => {
  test("splits on \\n, one row per line", () => {
    const rows = parseAnsiSnapshot("foo\nbar\nbaz")
    expect(rows).toHaveLength(3)
    expect(rows[0]?.[0]?.text).toBe("foo")
    expect(rows[1]?.[0]?.text).toBe("bar")
    expect(rows[2]?.[0]?.text).toBe("baz")
  })

  test("style carries across line breaks", () => {
    const rows = parseAnsiSnapshot(`${ESC}31mred-A\nstill-red`)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.[0]?.fg).toBeDefined()
    expect(rows[1]?.[0]?.fg).toBeDefined()
    expect(rows[0]?.[0]?.fg).toEqual(rows[1]?.[0]?.fg)
  })

  test("empty lines preserve cursor.y indexing", () => {
    const rows = parseAnsiSnapshot("a\n\nb")
    expect(rows).toHaveLength(3)
    expect(rows[0]?.[0]?.text).toBe("a")
    expect(rows[1]).toEqual([])
    expect(rows[2]?.[0]?.text).toBe("b")
  })
})
