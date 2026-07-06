/**
 * Adapter: maps an opentui-free `Chunk` from `./sgr.ts` to an opentui
 * `TextChunk` ready to drop into a `StyledText`. Lives in its own file
 * so `./sgr.ts` stays opentui-free — that file is loaded by the SGR
 * unit tests under vitest, which chokes on opentui's tree-sitter
 * `.scm` assets if they're pulled in transitively.
 *
 * The only reason this file exists is the test-runner dep boundary;
 * the conversion itself is trivial.
 */

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

/**
 * Flatten a 2D parsed snapshot (one chunk-list per row) into a single
 * `StyledText` whose chunks span every row with `\n` separators
 * between rows. Used by the terminal pane: rendering ONE `<text>`
 * element per snapshot keeps opentui's layout / screenY computation
 * in the same shape as the pre-SGR plain-text version, so the
 * cursor positioning math (`screenY + cursor.y`) lands on the right
 * row. Per-row `<text>` rendering (via Solid `<For>`) breaks that
 * invariant because flex column children don't necessarily occupy
 * exactly one row each.
 */
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
