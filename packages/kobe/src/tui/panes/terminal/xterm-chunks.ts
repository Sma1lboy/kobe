import { type Chunk, type RGB, ansi256ToRgb } from "./sgr"

const XTERM_COLOR_MODE_DEFAULT = 0
const XTERM_COLOR_MODE_PALETTE = 1 << 24
const XTERM_COLOR_MODE_RGB = 3 << 24

type XtermCellLike = {
  getChars(): string
  getWidth(): number
  isFgDefault(): boolean
  isBgDefault(): boolean
  isFgPalette(): boolean
  isBgPalette(): boolean
  isFgRGB(): boolean
  isBgRGB(): boolean
  getFgColorMode(): number
  getBgColorMode(): number
  getFgColor(): number
  getBgColor(): number
  isAttributeDefault(): boolean
  isBold(): boolean | number
  isDim(): boolean | number
  isItalic(): boolean | number
  isUnderline(): boolean | number
  isBlink(): boolean | number
  isInverse(): boolean | number
  isInvisible(): boolean | number
  isStrikethrough(): boolean | number
}

type RenderStyle = {
  fg: string
  bg: string
  attrs: number
}

const DEFAULT_RENDER_STYLE: RenderStyle = Object.freeze({ fg: "", bg: "", attrs: 0 })

function colorKeyToRGB(key: string): RGB | undefined {
  if (key === "") return undefined
  const sep = key.indexOf(":")
  const value = Number(key.slice(sep + 1))
  if (key.startsWith("rgb:")) return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
  if (key.startsWith("pal:")) return ansi256ToRgb(value)
  return undefined
}

function colorKey(cell: XtermCellLike, kind: "fg" | "bg"): string {
  const isDefault = kind === "fg" ? cell.isFgDefault() : cell.isBgDefault()
  if (isDefault) return ""
  const mode = kind === "fg" ? cell.getFgColorMode() : cell.getBgColorMode()
  const color = kind === "fg" ? cell.getFgColor() : cell.getBgColor()
  if (mode === XTERM_COLOR_MODE_RGB || (kind === "fg" ? cell.isFgRGB() : cell.isBgRGB())) return `rgb:${color}`
  if (mode === XTERM_COLOR_MODE_PALETTE || (kind === "fg" ? cell.isFgPalette() : cell.isBgPalette())) {
    return `pal:${color}`
  }
  if (mode === XTERM_COLOR_MODE_DEFAULT) return ""
  return ""
}

function cellStyle(cell: XtermCellLike): RenderStyle {
  let attrs = 0
  if (cell.isBold()) attrs |= 1 << 0
  if (cell.isDim()) attrs |= 1 << 1
  if (cell.isItalic()) attrs |= 1 << 2
  if (cell.isUnderline()) attrs |= 1 << 3
  if (cell.isBlink()) attrs |= 1 << 4
  if (cell.isInverse()) attrs |= 1 << 5
  if (cell.isInvisible()) attrs |= 1 << 6
  if (cell.isStrikethrough()) attrs |= 1 << 7
  return {
    fg: colorKey(cell, "fg"),
    bg: colorKey(cell, "bg"),
    attrs,
  }
}

function styleEquals(a: RenderStyle, b: RenderStyle): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.attrs === b.attrs
}

function renderStyleToChunkFields(style: RenderStyle): Pick<Chunk, "fg" | "bg" | "attributes"> {
  const fg = colorKeyToRGB(style.fg)
  const bg = colorKeyToRGB(style.bg)
  return {
    ...(fg ? { fg } : {}),
    ...(bg ? { bg } : {}),
    ...(style.attrs !== 0 ? { attributes: style.attrs } : {}),
  }
}

function isVisibleCell(cell: XtermCellLike): boolean {
  const chars = cell.getChars()
  if (chars !== "" && chars !== " ") return true
  return !cell.isAttributeDefault() || !cell.isFgDefault() || !cell.isBgDefault()
}

export function xtermLineToChunks(
  line: { length: number; getCell(index: number): XtermCellLike | undefined },
  minLast = -1,
): Chunk[] {
  let last = Math.min(line.length - 1, minLast)
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    if (isVisibleCell(cell)) last = Math.max(last, x)
  }
  if (last === -1) return []

  const out: Chunk[] = []
  let active = DEFAULT_RENDER_STYLE
  let buf = ""
  const flush = () => {
    if (buf === "") return
    out.push({ text: buf, ...renderStyleToChunkFields(active) })
    buf = ""
  }
  for (let x = 0; x <= last; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    const next = cellStyle(cell)
    if (!styleEquals(active, next)) {
      flush()
      active = next
    }
    buf += cell.getChars() || " "
  }
  flush()
  return out
}
