import { RGBA } from "@opentui/core"
import type { TextChunk } from "@opentui/core"
import type { Chunk, RGB } from "./sgr"

function toRGBA(rgb: RGB | undefined): RGBA | undefined {
  if (!rgb) return undefined
  return RGBA.fromInts(rgb[0], rgb[1], rgb[2])
}

export function toTextChunk(c: Chunk): TextChunk {
  return {
    __isChunk: true,
    text: c.text,
    ...(c.fg ? { fg: toRGBA(c.fg) } : {}),
    ...(c.bg ? { bg: toRGBA(c.bg) } : {}),
    ...(c.attributes !== undefined ? { attributes: c.attributes } : {}),
  }
}

export function rowsToStyledText(rows: readonly (readonly Chunk[])[]): TextChunk[] {
  const chunks: TextChunk[] = []
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) chunks.push({ __isChunk: true, text: "\n" })
    const row = rows[i]
    if (!row) continue
    for (const c of row) chunks.push(toTextChunk(c))
  }
  return chunks
}
