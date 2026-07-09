// Minimal SGR (ANSI color) parser for tmux capture-pane -e output.
// tmux emits only SGR sequences per line (no cursor movement), so a
// span-splitter is all we need — no full terminal emulator.
// ponytail: covers reset/bold/dim/italic/underline/reverse + 16/256/truecolor;
// add charset or OSC handling only if a capture ever shows artifacts.

import { charWidth } from "../../../kobe/src/lib/display-width"
import { colors } from "../colors"

export type Span = {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

export type Cell = Omit<Span, "text"> & {
  text: string
  skip?: boolean
}

export type TerminalRun = Omit<Span, "bg"> & {
  c: number
  w: number
}

export type TerminalBackgroundRun = {
  c: number
  w: number
  bg: string
}

export type TerminalLine = {
  rawAnsi: string
  runs: TerminalRun[]
  backgrounds: TerminalBackgroundRun[]
}

export type TerminalTheme = {
  defaultFg: string
  defaultBg: string
  ansi16: readonly string[]
}

const DEFAULT_ANSI16 = [
  "#141413", "#D47563", "#9ACA86", "#E8C96B", "#CC785C", "#9B87F5", "#D4967E", "#EAE7DF",
  "#3A3835", "#E08A76", "#B0DCA0", "#F2DA8C", "#D4967E", "#B3A3F8", "#E2B39F", "#FFFFFF",
] as const

export const DEFAULT_TERMINAL_THEME: TerminalTheme = {
  defaultFg: "#FFFFFF",
  defaultBg: colors.bg,
  ansi16: DEFAULT_ANSI16,
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function isTerminalTheme(value: unknown): value is TerminalTheme {
  return (
    isObject(value) &&
    typeof value.defaultFg === "string" &&
    typeof value.defaultBg === "string" &&
    Array.isArray(value.ansi16) &&
    value.ansi16.length === 16 &&
    value.ansi16.every((entry) => typeof entry === "string")
  )
}

export function terminalThemeFrom(
  value: unknown,
  fallback: TerminalTheme = DEFAULT_TERMINAL_THEME,
): TerminalTheme {
  if (!isTerminalTheme(value)) return fallback
  return {
    defaultFg: value.defaultFg,
    defaultBg: value.defaultBg,
    ansi16: value.ansi16,
  }
}

function xterm256(n: number, theme: TerminalTheme): string {
  if (n < 16) return theme.ansi16[n] ?? DEFAULT_ANSI16[n]
  if (n < 232) {
    const c = n - 16
    const steps = [0, 95, 135, 175, 215, 255]
    const r = steps[Math.floor(c / 36)]
    const g = steps[Math.floor((c % 36) / 6)]
    const b = steps[c % 6]
    return `rgb(${r},${g},${b})`
  }
  const v = 8 + (n - 232) * 10
  return `rgb(${v},${v},${v})`
}

type State = Omit<Span, "text"> & { reverse?: boolean }

const stripOsc = (line: string): string => line.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "")

const applySgr = (state: State, params: number[], theme: TerminalTheme): State => {
  let next = { ...state }
  for (let p = 0; p < params.length; p++) {
    const n = params[p]
    if (n === 0) next = {}
    else if (n === 1) next.bold = true
    else if (n === 2) next.dim = true
    else if (n === 3) next.italic = true
    else if (n === 4) next.underline = true
    else if (n === 7) next.reverse = true
    else if (n === 22) { next.bold = false; next.dim = false }
    else if (n === 23) next.italic = false
    else if (n === 24) next.underline = false
    else if (n === 27) next.reverse = false
    else if (n >= 30 && n <= 37) next.fg = theme.ansi16[n - 30]
    else if (n === 38 || n === 48) {
      const key = n === 38 ? "fg" : "bg"
      if (params[p + 1] === 5) { next[key] = xterm256(params[p + 2], theme); p += 2 }
      else if (params[p + 1] === 2) { next[key] = `rgb(${params[p + 2]},${params[p + 3]},${params[p + 4]})`; p += 4 }
    } else if (n === 39) next.fg = undefined
    else if (n >= 40 && n <= 47) next.bg = theme.ansi16[n - 40]
    else if (n === 49) next.bg = undefined
    else if (n >= 90 && n <= 97) next.fg = theme.ansi16[n - 90 + 8]
    else if (n >= 100 && n <= 107) next.bg = theme.ansi16[n - 100 + 8]
  }
  return next
}

const paramsFromSgr = (sequence: string): number[] => sequence.split(";").map((p) => (p === "" ? 0 : Number(p)))

const styleFromState = (state: State, theme: TerminalTheme): Omit<Cell, "text" | "skip"> => {
  const { reverse, ...rest } = state
  return reverse
    ? { ...rest, fg: state.bg ?? theme.defaultBg, bg: state.fg ?? theme.defaultFg }
    : { ...rest, fg: state.fg ?? theme.defaultFg }
}

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null

const graphemes = (text: string): string[] =>
  segmenter ? Array.from(segmenter.segment(text), (segment) => segment.segment) : Array.from(text)

const TEXT_PRESENTATION = "\uFE0E"
const EMOJI_PRESENTATION = "\uFE0F"
const extendedPictographic = /\p{Extended_Pictographic}/u

export function renderTextPresentation(text: string): string {
  let out = ""
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i) as number
    const glyph = String.fromCodePoint(cp)
    const next = i + glyph.length
    const variation = text[next]
    if (extendedPictographic.test(glyph)) {
      out += glyph
      if (variation === TEXT_PRESENTATION) {
        out += variation
        i = next + variation.length
      } else {
        out += TEXT_PRESENTATION
        i = next + (variation === EMOJI_PRESENTATION ? variation.length : 0)
      }
      continue
    }
    out += glyph
    i = next
  }
  return out
}

export const cellWidth = (text: string): number => {
  let width = 0
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) as number)
    if (w === 2) return 2
    if (w === 1) width = 1
  }
  return width
}

export function parseAnsiCells(line: string, cols: number, theme: TerminalTheme = DEFAULT_TERMINAL_THEME): Cell[] {
  const cells: Cell[] = Array.from({ length: cols }, () => ({ text: " ", skip: false }))
  let state: State = {}
  let col = 0
  line = stripOsc(line)

  const write = (text: string) => {
    for (const glyph of graphemes(text)) {
      const width = cellWidth(glyph)
      if (width === 0) {
        const prev = cells[Math.max(0, col - 1)]
        if (prev && !prev.skip) prev.text += glyph
        continue
      }
      if (col >= cols) return
      const style = styleFromState(state, theme)
      cells[col] = { ...style, text: glyph, skip: false }
      for (let i = 1; i < width && col + i < cols; i++) cells[col + i] = { ...style, text: "", skip: true }
      col += width
    }
  }

  let i = 0
  while (i < line.length) {
    const esc = line.indexOf("\x1b[", i)
    if (esc === -1) {
      write(line.slice(i))
      break
    }
    write(line.slice(i, esc))
    const end = line.indexOf("m", esc)
    if (end === -1) break
    state = applySgr(state, paramsFromSgr(line.slice(esc + 2, end)), theme)
    i = end + 1
  }

  return cells
}

const styleKey = (cell: Cell): string =>
  [cell.fg ?? "", cell.bold ? "1" : "0", cell.dim ? "1" : "0", cell.italic ? "1" : "0", cell.underline ? "1" : "0"]
    .join("|")

const codePointOf = (cell: Cell): number => cell.text.codePointAt(0) ?? 0

const glyphKind = (cell: Cell): string => {
  const cp = codePointOf(cell)
  if (cp >= 0x2580 && cp <= 0x259f) return "block"
  if (cp >= 0x2500 && cp <= 0x257f) return "box"
  if (cellWidth(cell.text) !== 1 || cp > 0x7f) return `symbol:${cell.text}`
  return "text"
}

const cellRunWidth = (cells: Cell[], col: number): number => {
  let width = 1
  while (col + width < cells.length && cells[col + width].skip) width++
  return width
}

function foregroundRuns(cells: Cell[]): TerminalRun[] {
  const runs: TerminalRun[] = []
  let col = 0
  while (col < cells.length) {
    const cell = cells[col]
    if (cell.skip || cell.text === " ") {
      col++
      continue
    }

    const kind = glyphKind(cell)
    const key = styleKey(cell)
    const start = col
    let width = 0
    let text = ""
    let end = col

    while (end < cells.length) {
      const next = cells[end]
      if (next.skip || next.text === " " || glyphKind(next) !== kind || styleKey(next) !== key) break
      const w = cellRunWidth(cells, end)
      text += next.text
      width += w
      end += w
    }

    runs.push({
      c: start,
      w: width,
      text,
      fg: cell.fg,
      bold: cell.bold,
      dim: cell.dim,
      italic: cell.italic,
      underline: cell.underline,
    })
    col = end
  }
  return runs
}

function backgroundRuns(cells: Cell[]): TerminalBackgroundRun[] {
  const runs: TerminalBackgroundRun[] = []
  let run: TerminalBackgroundRun | null = null
  for (let c = 0; c < cells.length; c++) {
    const bg = cells[c].bg
    if (!bg) {
      if (run) runs.push(run)
      run = null
      continue
    }
    if (run && run.bg === bg && run.c + run.w === c) run.w++
    else {
      if (run) runs.push(run)
      run = { c, w: 1, bg }
    }
  }
  if (run) runs.push(run)
  return runs
}

export function terminalLineFromAnsi(
  rawAnsi: string,
  cols: number,
  theme: TerminalTheme = DEFAULT_TERMINAL_THEME,
): TerminalLine {
  const cells = parseAnsiCells(rawAnsi, cols, theme)
  return {
    rawAnsi,
    runs: foregroundRuns(cells),
    backgrounds: backgroundRuns(cells),
  }
}

export function normalizeTerminalLine(
  line: string | TerminalLine | undefined,
  cols: number,
  theme: TerminalTheme = DEFAULT_TERMINAL_THEME,
): TerminalLine {
  if (!line) return { rawAnsi: "", runs: [], backgrounds: [] }
  return terminalLineFromAnsi(typeof line === "string" ? line : line.rawAnsi, cols, theme)
}

export function parseAnsiLine(
  line: string,
  prev: State = {},
  theme: TerminalTheme = DEFAULT_TERMINAL_THEME,
): { spans: Span[]; state: State } {
  const spans: Span[] = []
  let state: State = { ...prev }
  let buf = ""

  // Strip OSC sequences (tmux emits OSC 8 hyperlinks) — we only render SGR.
  line = stripOsc(line)

  const flush = () => {
    if (!buf) return
    spans.push({ ...styleFromState(state, theme), text: buf })
    buf = ""
  }

  let i = 0
  while (i < line.length) {
    const esc = line.indexOf("\x1b[", i)
    if (esc === -1) {
      buf += line.slice(i)
      break
    }
    buf += line.slice(i, esc)
    const end = line.indexOf("m", esc)
    if (end === -1) break
    flush()
    state = applySgr(state, paramsFromSgr(line.slice(esc + 2, end)), theme)
    i = end + 1
  }
  flush()
  return { spans, state }
}
