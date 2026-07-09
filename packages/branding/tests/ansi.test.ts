import { describe, expect, test } from "bun:test"
import {
  renderTextPresentation,
  normalizeTerminalLine,
  parseAnsiCells,
  terminalLineFromAnsi,
  terminalThemeFrom,
  type TerminalTheme,
} from "../src/quicklook/ansi"
import quicklookSpec from "../src/quicklook/quicklook.replay.json"

describe("ANSI cell parser", () => {
  test("keeps terminal-narrow symbols in one cell without shifting following text", () => {
    const cells = parseAnsiCells("A⚠B", 5)

    expect(cells.map((cell) => cell.text)).toEqual(["A", "⚠", "B", " ", " "])
    expect(cells.map((cell) => cell.skip)).toEqual([false, false, false, false, false])
  })

  test("records positioned runs at terminal columns", () => {
    const line = terminalLineFromAnsi(" ⚠ DAEMON OUT OF DATE           │", 40)

    expect(line.runs.find((run) => run.text === "⚠")).toMatchObject({ c: 1, w: 1 })
    expect(line.runs.find((run) => run.text === "│")).toMatchObject({ c: 32, w: 1 })
  })

  test("coalesces contiguous block glyphs into one positioned run", () => {
    const line = terminalLineFromAnsi("  ▐▛███▜▌   Claude", 24)

    expect(line.runs.find((run) => run.text === "▐▛███▜▌")).toMatchObject({ c: 2, w: 7 })
  })

  test("resolves default and ANSI 16 colors from the capture theme", () => {
    const theme: TerminalTheme = {
      defaultFg: "#ffffff",
      defaultBg: "#101010",
      ansi16: [
        "#000000", "#aa0000", "#00aa00", "#aaaa00", "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa",
        "#555555", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
      ],
    }

    const line = terminalLineFromAnsi("\x1b[31mR\x1b[39mD", 4, theme)

    expect(line.runs.find((run) => run.text === "R")?.fg).toBe("#aa0000")
    expect(line.runs.find((run) => run.text === "D")?.fg).toBe("#ffffff")
  })

  test("re-resolves v2 raw ANSI against the editable capture theme", () => {
    const theme: TerminalTheme = {
      defaultFg: "#d78787",
      defaultBg: "#101010",
      ansi16: [
        "#000000", "#aa0000", "#00aa00", "#aaaa00", "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa",
        "#555555", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
      ],
    }

    const line = normalizeTerminalLine({
      rawAnsi: "\x1b[39mClaude",
      runs: [{ c: 0, w: 6, text: "Claude", fg: "#ffffff" }],
      backgrounds: [],
    }, 12, theme)

    expect(line.runs.find((run) => run.text === "Claude")?.fg).toBe("#d78787")
  })

  test("preserves captured glyphs instead of rewriting them in the parser", () => {
    const line = terminalLineFromAnsi("⚠ ✳", 4)

    expect(line.runs.map((run) => run.text)).toEqual(["⚠", "✳"])
  })

  test("marks emoji-capable symbols for text presentation at render time", () => {
    const line = terminalLineFromAnsi("⏺ Please run /login", 20)

    expect(line.runs[0].text).toBe("⏺")
    expect(renderTextPresentation(line.runs[0].text)).toBe("⏺\uFE0E")
    expect(renderTextPresentation("⏺\uFE0F 🔍 📦 ★")).toBe("⏺\uFE0E 🔍\uFE0E 📦\uFE0E ★")
  })

  test("renders default-color block glyphs with the terminal default foreground", () => {
    const theme: TerminalTheme = {
      defaultFg: "#ffffff",
      defaultBg: "#101010",
      ansi16: [
        "#000000", "#aa0000", "#00aa00", "#aaaa00", "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa",
        "#555555", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
      ],
    }

    const line = terminalLineFromAnsi("\x1b[39m▌ ▐▛███▜▌   Product", 24, theme)

    expect(line.runs.find((run) => run.text === "▌")?.fg).toBe("#ffffff")
    expect(line.runs.find((run) => run.text === "▐▛███▜▌")?.fg).toBe("#ffffff")
    expect(line.runs.find((run) => run.text === "Product")?.fg).toBe("#ffffff")
  })

  test("uses a valid capture theme directly without parser rule merging", () => {
    const ansi16 = [
      "#000000", "#aa0000", "#00aa00", "#aaaa00", "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa",
      "#555555", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
    ]
    const fallback: TerminalTheme = {
      defaultFg: "#ffffff",
      defaultBg: "#101010",
      ansi16,
    }

    const theme = terminalThemeFrom({ defaultFg: "#eeeeee", defaultBg: "#000000", ansi16 }, fallback)
    const line = terminalLineFromAnsi("⚠ ▐▛███▜▌ Product", 24, theme)

    expect(theme.defaultFg).toBe("#eeeeee")
    expect(line.runs.find((run) => run.text === "⚠")).toBeDefined()
    expect(line.runs.find((run) => run.text === "▐▛███▜▌")?.fg).toBe("#eeeeee")
  })

  test("drops unsupported parser patch fields from capture themes", () => {
    const ansi16 = [
      "#000000", "#aa0000", "#00aa00", "#aaaa00", "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa",
      "#555555", "#ff5555", "#55ff55", "#ffff55", "#5555ff", "#ff55ff", "#55ffff", "#ffffff",
    ]
    const theme = terminalThemeFrom({
      defaultFg: "#eeeeee",
      defaultBg: "#000000",
      ansi16,
      glyphMap: { "⚠": "!" },
      runOverrides: [],
    })

    expect(Object.keys(theme).sort()).toEqual(["ansi16", "defaultBg", "defaultFg"])
  })

  test("quicklook theme does not patch parser output", () => {
    expect("glyphMap" in quicklookSpec.theme).toBe(false)
    expect("runOverrides" in quicklookSpec.theme).toBe(false)
  })

  test("preserves background style on trailing spaces until reset", () => {
    const cells = parseAnsiCells("\x1b[48;2;1;2;3mX  \x1b[0mY", 5)

    expect(cells.map((cell) => cell.text)).toEqual(["X", " ", " ", "Y", " "])
    expect(cells.slice(0, 3).map((cell) => cell.bg)).toEqual(["rgb(1,2,3)", "rgb(1,2,3)", "rgb(1,2,3)"])
    expect(cells[3].bg).toBeUndefined()
  })

  test("applies reverse video at cell level", () => {
    const cells = parseAnsiCells("\x1b[31;44;7mR", 1)

    expect(cells[0]).toMatchObject({
      text: "R",
      fg: "#CC785C",
      bg: "#D47563",
    })
  })
})
