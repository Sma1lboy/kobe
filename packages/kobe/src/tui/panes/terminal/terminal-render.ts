import { charWidth } from "../../../lib/display-width.ts"
import type { CursorPos } from "./pty"
import { ATTR, type Chunk, type RGB } from "./sgr"

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
    // Cursor sits past the row's rendered cells (blank tail a backend
    // didn't emit). Pad to the REAL column before drawing — appending at
    // end-of-text instead is how the cursor visually froze while xterm's
    // cursor kept advancing over typed spaces.
    if (x > col) out.push({ text: " ".repeat(x - col) })
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

/**
 * LOCAL PATCH for an opentui attribute leak (kept in kobe rather than
 * upstreamed — see the `sealRowEndAttributes` call in the React pane).
 *
 * opentui's zig diff renderer declares `runLength` INSIDE its per-row loop
 * (`renderer.zig`, `prepareRenderFrameWithWriter`) while its SGR writer only
 * ever ADDS attribute bits (`ansi.zig` emits `\e[4m`, never `\e[24m`). So the
 * first cell of a new row takes the `runStart == -1` branch with
 * `runLength == 0` and SKIPS the `\e[0m` reset — any attribute still open at
 * the end of the previous row bleeds into every following row until some
 * other run happens to reset. A styled run that reaches the LAST column is
 * exactly what triggers it, i.e. a wrapped URL: the terminal draws the rest
 * of the frame underlined ("link underline runs off into the text below").
 *
 * The fix has to live where the row still exists as data: clear the
 * attributes on the final cell of a row that fills the full width, and
 * preserve what those attributes were DRAWING by resolving them to explicit
 * colors — INVERSE becomes a literal fg/bg swap, so a cursor or selection
 * cell parked in the last column keeps its highlight instead of vanishing.
 * Underline/bold/italic lose one cell of decoration at the wrap point; that
 * is the whole cost, and it is invisible next to a frame-wide bleed.
 *
 * Rows shorter than `cols` need no sealing: their run is followed by another
 * chunk on the same row, which resets normally.
 */
export function sealRowEndAttributes(
  rows: readonly (readonly Chunk[])[],
  cols: number,
  defaultFg: RGB,
  defaultBg: RGB,
): readonly (readonly Chunk[])[] {
  if (cols <= 0) return rows
  return rows.map((row) => {
    const lastIndex = row.length - 1
    const last = row[lastIndex]
    if (!last) return row
    const attrs = last.attributes ?? 0
    if (attrs === 0) return row
    let width = 0
    for (const chunk of row) width += chunkCells(Array.from(chunk.text))
    if (width < cols) return row

    const chars = Array.from(last.text)
    const tail = chars[chars.length - 1]
    if (tail === undefined) return row
    // INVERSE is the only attribute carrying information rather than
    // decoration here (cursor + selection both paint with it), so replay it
    // as swapped colors. `defaultFg`/`defaultBg` stand in for "the chunk
    // didn't say" — the pane passes its theme's text/background.
    const fg = last.fg ?? defaultFg
    const bg = last.bg ?? defaultBg
    const sealed: Chunk = (attrs & ATTR.INVERSE) !== 0 ? { text: tail, fg: bg, bg: fg } : { text: tail, fg, bg }

    const head = chars.slice(0, -1).join("")
    const rebuilt = row.slice(0, lastIndex)
    if (head) rebuilt.push(cloneChunk(last, head))
    rebuilt.push(sealed)
    return rebuilt
  })
}
