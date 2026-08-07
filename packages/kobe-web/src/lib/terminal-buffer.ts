import type { Terminal } from "@xterm/xterm"
import {
  type ColoredLine,
  cellBgColor,
  cellColor,
  type Seg,
} from "./tty-color.ts"

export function visibleBufferText(term: Terminal): string {
  const buffer = term.buffer.active
  const start = buffer.viewportY
  const end = Math.min(buffer.length, start + term.rows)
  const lines: string[] = []
  for (let index = start; index < end; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "")
  }
  return lines.join("\n")
}

/** Extract the visible viewport as colored lines (fg per run), coalescing
 *  same-color cells into segments so the translated view keeps ANSI color. */
export function coloredViewport(term: Terminal): ColoredLine[] {
  const buffer = term.buffer.active
  const start = buffer.viewportY
  const end = Math.min(buffer.length, start + term.rows)
  const out: ColoredLine[] = []
  for (let y = start; y < end; y += 1) {
    const line = buffer.getLine(y)
    const segs: Seg[] = []
    let text = ""
    let cur: Seg | null = null
    for (let x = 0; line && x < term.cols; x += 1) {
      const cell = line.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      const ch = cell.getChars() || " "
      const color = cellColor(cell)
      const bg = cellBgColor(cell)
      text += ch
      if (cur && cur.color === color && (cur.bg ?? null) === bg) cur.text += ch
      else {
        cur = { text: ch, color, bg }
        segs.push(cur)
      }
    }
    out.push({ text: text.replace(/\s+$/, ""), segs })
  }
  return out
}
