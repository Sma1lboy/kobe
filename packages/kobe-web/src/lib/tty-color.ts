/**
 * ANSI foreground color extraction for the TTY-translated render. Keeping
 * the terminal's colors is what makes the translated view read as the same
 * product as the raw terminal — without them the ⏺ orange, activity glyphs,
 * diff greens/reds, and syntax highlight all flatten to grey.
 *
 * Pure: the xterm-specific cell reads live in ChatTerminal; this module only
 * maps a palette index / packed RGB to a CSS color, and defines the colored-
 * line shape the parser + view share.
 */

/** A run of same-colored characters on one line. `color` null = default fg. */
export interface Seg {
  text: string
  color: string | null
  /** Background color run (inverse-video / menu selection); absent = default. */
  bg?: string | null
}

/** One viewport line: the plain text (for grammar detection) plus the colored
 *  runs (for rendering). */
export interface ColoredLine {
  text: string
  segs: Seg[]
}

/** Strip leading whitespace runs (the CLI's space-padded right alignment) so
 *  a line can be re-aligned with CSS instead of clipping at the container. */
export function trimLeadingColored(line: ColoredLine): ColoredLine {
  const segs = [...line.segs]
  while (segs[0] && /^\s*$/.test(segs[0].text)) segs.shift()
  const first = segs[0]
  if (first) segs[0] = { ...first, text: first.text.trimStart() }
  return { text: line.text.trimStart(), segs }
}

/** Content equality for one line — the frame stabilizer's predicate. */
export function sameColoredLine(a: ColoredLine, b: ColoredLine): boolean {
  if (a.text !== b.text || a.segs.length !== b.segs.length) return false
  for (let i = 0; i < a.segs.length; i++) {
    const x = a.segs[i]
    const y = b.segs[i]
    if (!x || !y) return false
    if (
      x.text !== y.text ||
      x.color !== y.color ||
      (x.bg ?? null) !== (y.bg ?? null)
    )
      return false
  }
  return true
}

/** Strip trailing whitespace runs — terminal rows are padded to full width,
 *  which defeats shrink-wrap layouts (w-fit) and bloats copied text. */
export function trimTrailingColored(line: ColoredLine): ColoredLine {
  const segs = [...line.segs]
  while (segs.length > 0 && /^\s*$/.test(segs[segs.length - 1]?.text ?? "")) segs.pop()
  const last = segs[segs.length - 1]
  if (last) segs[segs.length - 1] = { ...last, text: last.text.replace(/\s+$/, "") }
  return { text: line.text.replace(/\s+$/, ""), segs }
}

/** The 6 levels the xterm 256-color cube steps through. */
const CUBE = [0, 95, 135, 175, 215, 255] as const

/** ANSI 0-15, mirroring the claude xterm theme (ChatTerminal's palette) so a
 *  base-color cell renders the same hue the raw terminal shows. */
const BASE16 = [
  "#141413",
  "#d47563",
  "#9aca86",
  "#e8c96b",
  "#61aaf2",
  "#9b87f5",
  "#d4967e",
  "#a9a39a",
  "#6b665f",
  "#d47563",
  "#9aca86",
  "#e8c96b",
  "#61aaf2",
  "#9b87f5",
  "#e0ab96",
  "#eae7df",
] as const

function hex2(n: number): string {
  return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0")
}

/** Map an xterm 256-color palette index to a CSS hex color. */
export function paletteColor(index: number): string {
  if (index < 16) return BASE16[index] ?? "#eae7df"
  if (index < 232) {
    const i = index - 16
    const r = CUBE[Math.floor(i / 36) % 6]
    const g = CUBE[Math.floor(i / 6) % 6]
    const b = CUBE[i % 6]
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`
  }
  const level = 8 + (index - 232) * 10
  return `#${hex2(level)}${hex2(level)}${hex2(level)}`
}

/** The subset of xterm's IBufferCell this module reads — kept structural so
 *  the lib never imports xterm. */
export interface FgCell {
  isFgDefault(): boolean
  isFgPalette(): boolean
  isFgRGB(): boolean
  getFgColor(): number
}

/** CSS color for a cell's foreground, or null when it uses the default fg. */
export function cellColor(cell: FgCell): string | null {
  if (cell.isFgDefault()) return null
  const raw = cell.getFgColor()
  if (cell.isFgRGB()) {
    const r = (raw >>> 16) & 0xff
    const g = (raw >>> 8) & 0xff
    const b = raw & 0xff
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`
  }
  if (cell.isFgPalette()) return paletteColor(raw)
  return null
}

/** Background sibling of {@link FgCell} — inverse-video / selection runs. */
export interface BgCell {
  isBgDefault(): boolean
  isBgRGB(): boolean
  isBgPalette(): boolean
  getBgColor(): number
}

export function cellBgColor(cell: BgCell): string | null {
  if (cell.isBgDefault()) return null
  const raw = cell.getBgColor()
  if (cell.isBgRGB()) {
    const r = (raw >>> 16) & 0xff
    const g = (raw >>> 8) & 0xff
    const b = raw & 0xff
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`
  }
  if (cell.isBgPalette()) return paletteColor(raw)
  return null
}
