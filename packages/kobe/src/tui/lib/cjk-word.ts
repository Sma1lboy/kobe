/**
 * CJK-aware word boundaries for the TUI's text inputs, in DISPLAY-COLUMN
 * space.
 *
 * opentui's native (Zig) edit buffer computes word jumps itself, and for
 * Chinese text they are useless: a run of 汉字 is walked in arbitrary
 * fixed-width hops, and ASCII/fullwidth punctuation (`]`, `=`, `】`…) never
 * splits. kobe is Simplified-Chinese-default, so alt+←/→ and alt+backspace
 * inside a Chinese prompt are a core editing path, not an edge case.
 *
 * `Intl.Segmenter("zh", { granularity: "word" })` (ICU, built into Bun)
 * does real Chinese word segmentation — 「中文输入法优化」→ 中文|输入|法|优|化 —
 * and emits every punctuation mark as its own non-word segment, which makes
 * `]`/`=`/fullwidth punctuation natural split points for free.
 *
 * Coordinate contract (probed against @opentui/core 0.4.3): the edit
 * buffer's cursor `col`/`offset` are TERMINAL CELLS, not UTF-16 units — a
 * CJK glyph occupies 2, mid-glyph positions snap down. All public functions
 * here therefore take and return column offsets within ONE logical line;
 * `cjk-word-patch.ts` owns the per-line/renderable wiring.
 */

import { charWidth } from "../../lib/display-width.ts"

const segmenter = new Intl.Segmenter("zh", { granularity: "word" })

/** JS string index → display column (cells before `index`). */
export function indexToCol(line: string, index: number): number {
  let col = 0
  let i = 0
  for (const ch of line) {
    if (i >= index) break
    col += charWidth(ch.codePointAt(0) as number)
    i += ch.length
  }
  return col
}

/** Display column → JS string index, snapping down mid-glyph (native rule). */
export function colToIndex(line: string, col: number): number {
  let acc = 0
  let i = 0
  for (const ch of line) {
    const w = charWidth(ch.codePointAt(0) as number)
    if (acc + w > col) return i
    acc += w
    i += ch.length
  }
  return line.length
}

const isSpace = (s: string) => s.trim().length === 0

interface Seg {
  readonly start: number
  readonly end: number
  readonly kind: "word" | "punct" | "space"
}

function segmentsOf(line: string): Seg[] {
  const out: Seg[] = []
  for (const s of segmenter.segment(line)) {
    out.push({
      start: s.index,
      end: s.index + s.segment.length,
      kind: s.isWordLike ? "word" : isSpace(s.segment) ? "space" : "punct",
    })
  }
  return out
}

/**
 * Column of the previous word boundary before `col` (0 if none). Skips
 * whitespace, then lands on the start of the word — or of the whole
 * punctuation run (vim-style: `]]==` is one hop, a lone `=` still splits).
 */
export function prevWordCol(line: string, col: number): number {
  const segs = segmentsOf(line)
  let i = segs.length - 1
  const idx = colToIndex(line, col)
  while (i >= 0 && (segs[i] as Seg).start >= idx) i--
  while (i >= 0 && (segs[i] as Seg).kind === "space") i--
  if (i < 0) return 0
  const kind = (segs[i] as Seg).kind
  while (i > 0 && (segs[i - 1] as Seg).kind === kind && kind === "punct") i--
  return indexToCol(line, (segs[i] as Seg).start)
}

/**
 * Column of the next word boundary after `col` (end of line if none).
 * Mirror of {@link prevWordCol}: skip whitespace, consume one word or one
 * punctuation run, land after it.
 */
export function nextWordCol(line: string, col: number): number {
  const segs = segmentsOf(line)
  const idx = colToIndex(line, col)
  let i = 0
  while (i < segs.length && (segs[i] as Seg).end <= idx) i++
  while (i < segs.length && (segs[i] as Seg).kind === "space") i++
  if (i >= segs.length) return indexToCol(line, line.length)
  const kind = (segs[i] as Seg).kind
  while (i < segs.length - 1 && (segs[i + 1] as Seg).kind === kind && kind === "punct") i++
  return indexToCol(line, (segs[i] as Seg).end)
}
