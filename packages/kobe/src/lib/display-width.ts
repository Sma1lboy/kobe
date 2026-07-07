/**
 * Terminal cell-width measurement, shared by every layer that has to agree
 * with the terminal grid: CLI table export (`cli/export-cmd.ts`) and the
 * TUI's CJK word-boundary math (`tui/lib/cjk-word.ts`, whose cursor offsets
 * are display-column offsets in opentui's native edit buffer).
 *
 * Moved out of `cli/export-cmd.ts` verbatim so the TUI doesn't import from
 * the CLI layer. Behavior notes live on each function.
 */

/**
 * Terminal display width of `s` in cells. Iterates by code point (so astral
 * characters — CJK Extension B, emoji — count once, not as two UTF-16 units),
 * mirroring the code-point awareness of `filetree/rows.ts`'s `truncatePathTail`.
 * East-Asian-wide / fullwidth glyphs and most emoji occupy two cells; combining
 * marks and zero-width formatting characters occupy none; everything else one.
 *
 * kobe is Simplified-Chinese-default, so a CJK task title is the common case —
 * measuring by `String.length` (UTF-16 units) under-counts it and shoves every
 * column to its right out of alignment. Exported for unit tests.
 */
export function displayWidth(s: string): number {
  let width = 0
  for (const ch of s) width += charWidth(ch.codePointAt(0) as number)
  return width
}

/** Cell width of a single Unicode code point: 0 (zero-width), 2 (wide), or 1. */
export function charWidth(cp: number): number {
  // Zero-width: combining marks + bidi/format controls + variation selectors.
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
    (cp >= 0x1ab0 && cp <= 0x1aff) || // combining diacritical marks extended
    (cp >= 0x1dc0 && cp <= 0x1dff) || // combining diacritical marks supplement
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space … LTR/RTL marks
    (cp >= 0x202a && cp <= 0x202e) || // bidi embedding / override
    (cp >= 0x2060 && cp <= 0x2064) || // word joiner … invisible operators
    (cp >= 0x20d0 && cp <= 0x20ff) || // combining marks for symbols
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    cp === 0xfeff // zero-width no-break space (BOM)
  ) {
    return 0
  }
  // Wide: East Asian Wide + Fullwidth + the common emoji / pictograph blocks.
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x2329 ||
    cp === 0x232a || // angle brackets
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … Kangxi … CJK symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … Katakana … CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi Syllables
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji, symbols & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Unified Ext B and beyond
  ) {
    return 2
  }
  return 1
}
