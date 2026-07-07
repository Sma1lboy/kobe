import { charWidth } from "../../../lib/display-width.ts"
import type { CursorPos } from "./pty"
import { ATTR, type Chunk } from "./sgr"

/**
 * Heuristic: is this acquire-error message about the user's shell
 * being absent / unreachable? Used to swap a plain-English hint in for
 * the raw error tail.
 */
export function isShellMissing(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes("enoent") || m.includes("not found")
}

function cloneChunk(c: Chunk, text: string, attrs = c.attributes ?? 0): Chunk {
  return {
    text,
    ...(c.fg ? { fg: c.fg } : {}),
    ...(c.bg ? { bg: c.bg } : {}),
    ...(attrs !== 0 ? { attributes: attrs } : {}),
  }
}

/** Sum the display width (in cells) of a chunk's text. */
function chunkCells(chars: readonly string[]): number {
  let w = 0
  for (const ch of chars) w += charWidth(ch.codePointAt(0) as number) || 1
  return w
}

function overlayCursorRow(row: readonly Chunk[], x: number): Chunk[] {
  const out: Chunk[] = []
  // `x` is a terminal CELL column. Chunk text is code points, and a wide
  // (CJK / fullwidth / emoji) glyph is ONE code point but TWO cells — so we
  // advance the column cursor by each char's display WIDTH, not by 1.
  // Counting code points instead drifted the inverse-cell cursor left by one
  // column per wide char before it (the "cursor doesn't follow the text" bug
  // when typing Chinese).
  let col = 0
  let inserted = false

  for (const chunk of row) {
    if (inserted) {
      out.push(chunk)
      continue
    }
    const chars = Array.from(chunk.text)
    // Walk this chunk's chars by cell width; the cursor lands on the char
    // whose cell span [localCol, localCol + width) contains `x` (so a wide
    // char's trailing cell resolves to the char itself).
    let localCol = col
    let hit = -1
    for (let idx = 0; idx < chars.length; idx++) {
      const w = charWidth((chars[idx] as string).codePointAt(0) as number) || 1
      if (x >= localCol && x < localCol + w) {
        hit = idx
        break
      }
      localCol += w
    }
    if (hit >= 0) {
      const before = chars.slice(0, hit).join("")
      const after = chars.slice(hit + 1).join("")
      if (before) out.push(cloneChunk(chunk, before))
      out.push(cloneChunk(chunk, chars[hit] || " ", (chunk.attributes ?? 0) | ATTR.INVERSE))
      if (after) out.push(cloneChunk(chunk, after))
      inserted = true
    } else {
      out.push(chunk)
      col += chunkCells(chars)
    }
  }

  if (!inserted) {
    out.push({ text: " ", attributes: ATTR.INVERSE })
  }
  return out
}

export function overlayCursor(
  rows: readonly (readonly Chunk[])[],
  cursor: CursorPos | null,
): readonly (readonly Chunk[])[] {
  if (!cursor) return rows
  return rows.map((row, y) => (y === cursor.y ? overlayCursorRow(row, cursor.x) : row))
}
