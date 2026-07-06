import type { CursorPos } from "./pty"
import { ATTR, type Chunk } from "./sgr"

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

function overlayCursorRow(row: readonly Chunk[], x: number): Chunk[] {
  const out: Chunk[] = []
  let col = 0
  let inserted = false

  for (const chunk of row) {
    const chars = Array.from(chunk.text)
    const start = col
    const end = start + chars.length
    if (!inserted && x >= start && x < end) {
      const idx = x - start
      const before = chars.slice(0, idx).join("")
      const cursorChar = chars[idx] ?? " "
      const after = chars.slice(idx + 1).join("")
      if (before) out.push(cloneChunk(chunk, before))
      out.push(cloneChunk(chunk, cursorChar || " ", (chunk.attributes ?? 0) | ATTR.INVERSE))
      if (after) out.push(cloneChunk(chunk, after))
      inserted = true
    } else {
      out.push(chunk)
    }
    col = end
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
