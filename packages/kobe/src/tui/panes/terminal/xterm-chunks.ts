import { ATTR, type Chunk, type RGB, ansi256ToRgb } from "./sgr"

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

/**
 * Convert one of `colorKey`'s opaque keys (`""` / `rgb:<packed>` /
 * `pal:<index>`) to an RGB triple for a `Chunk`. The key is only an
 * in-process comparison token for run-coalescing; this resolves it to
 * the real color without any ANSI text in between.
 */
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
  if (cell.isBold()) attrs |= ATTR.BOLD
  if (cell.isDim()) attrs |= ATTR.DIM
  if (cell.isItalic()) attrs |= ATTR.ITALIC
  if (cell.isUnderline()) attrs |= ATTR.UNDERLINE
  if (cell.isBlink()) attrs |= ATTR.BLINK
  if (cell.isInverse()) attrs |= ATTR.INVERSE
  // xterm's "invisible" flag is the SGR 8 concealed attribute → ATTR.HIDDEN.
  if (cell.isInvisible()) attrs |= ATTR.HIDDEN
  if (cell.isStrikethrough()) attrs |= ATTR.STRIKETHROUGH
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

/**
 * One reusable scratch cell, shared across every line conversion.
 *
 * `@xterm/headless`'s `line.getCell(x)` allocates a fresh cell object on
 * every call; `getCell(x, cell)` instead loads the data into `cell` and
 * returns that same reference (xterm's documented "avoid recreating cell
 * objects" fast path). On the terminal render hot path this fires for
 * every cell of every converted line, so the no-arg form was the dominant
 * per-cell allocation.
 *
 * There is no public `CellData` constructor in `@xterm/headless` (it
 * exports only `Terminal`), and `getNullCell()` needs a live buffer this
 * function never sees. So we seed the scratch lazily from the first
 * `getCell` call we ever make (a fresh cell obtained without the scratch
 * arg) and reuse it forever after — a single program-wide allocation
 * amortized to zero per line.
 *
 * Reuse is safe ONLY because nothing here retains a cell reference across
 * iterations: each pass reads the cell's chars + attributes immediately
 * (`cellStyle` copies every attribute out into a fresh `RenderStyle`,
 * `getChars()` extracts the text) and moves on. Stashing the cell object
 * itself would see it clobbered on the next `getCell`.
 */
let scratchCell: XtermCellLike | undefined

function getCellReusing(
  line: { getCell(index: number, cell?: XtermCellLike): XtermCellLike | undefined },
  x: number,
): XtermCellLike | undefined {
  if (scratchCell === undefined) {
    // First-ever call: no scratch yet, so this one fresh cell becomes it.
    const seeded = line.getCell(x)
    if (seeded) scratchCell = seeded
    return seeded
  }
  return line.getCell(x, scratchCell)
}

/**
 * Map one xterm buffer line to a list of opentui-ready style runs.
 *
 * This is the direct cell→chunk path: we read xterm's authoritative
 * cells (chars + fg/bg/attrs) and coalesce contiguous same-style cells
 * into one `Chunk`, resolving colors straight to RGB. No ANSI is
 * produced or re-parsed. `minLast` keeps the cursor column visible even
 * when the trailing cells are blank, mirroring the snapshot the cursor
 * overlay is computed against.
 */
export function xtermLineToChunks(
  line: { length: number; getCell(index: number, cell?: XtermCellLike): XtermCellLike | undefined },
  minLast = -1,
): Chunk[] {
  // `Math.max` is load-bearing: the `minLast` seed (cursor column) must
  // survive the visible-cell scan. A plain `last = x` let the FIRST
  // visible cell clobber the seed, so trailing BLANK cells (typed spaces
  // echo as default-style blanks) were never emitted and the cursor
  // overlay stuck at end-of-text — "cursor doesn't move on space".
  let last = Math.min(line.length - 1, minLast)
  for (let x = 0; x < line.length; x++) {
    const cell = getCellReusing(line, x)
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
    const cell = getCellReusing(line, x)
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
