/**
 * Terminal display width — how many CELLS a string / code point occupies,
 * as opposed to `String.length` (UTF-16 units) or code-point count. kobe is
 * Simplified-Chinese-default, so wide (CJK / fullwidth) glyphs are the common
 * case: measuring by length under-counts them and shoves everything to their
 * right out of alignment.
 *
 * Framework-free (no opentui/Solid) so both the `kobe export` table renderer
 * and the embedded-terminal cursor overlay (`terminal-render.ts`, which must
 * map a cell-column cursor onto code-point-indexed chunk text) share ONE
 * width table.
 */

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

/**
 * Terminal display width of `s` in cells. Iterates by code point (so astral
 * characters — CJK Extension B, emoji — count once, not as two UTF-16 units).
 */
export function displayWidth(s: string): number {
  let width = 0
  for (const ch of s) width += charWidth(ch.codePointAt(0) as number)
  return width
}
