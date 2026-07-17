import { describe, expect, it } from "vitest"
import { charWidth, displayWidth } from "../../src/lib/display-width.ts"

/**
 * Cell-width contract for `charWidth`/`displayWidth`. These feed the
 * `kobe export` table renderer and the embedded-terminal cursor overlay, so an
 * under-counted wide glyph drifts every cell to its right by one column — the
 * exact misalignment the module exists to prevent.
 */
describe("charWidth", () => {
  it("counts plain ASCII / Latin as one cell", () => {
    expect(charWidth("a".codePointAt(0) as number)).toBe(1)
    expect(charWidth("Z".codePointAt(0) as number)).toBe(1)
    expect(charWidth(" ".codePointAt(0) as number)).toBe(1)
    expect(charWidth("ü".codePointAt(0) as number)).toBe(1)
  })

  it("counts CJK ideographs, kana, and fullwidth forms as two cells", () => {
    expect(charWidth("中".codePointAt(0) as number)).toBe(2) // CJK Unified
    expect(charWidth("あ".codePointAt(0) as number)).toBe(2) // Hiragana
    expect(charWidth("Ａ".codePointAt(0) as number)).toBe(2) // Fullwidth A (U+FF21)
    expect(charWidth("한".codePointAt(0) as number)).toBe(2) // precomposed Hangul syllable
  })

  it("counts astral CJK / emoji as two cells (single code point)", () => {
    expect(charWidth(0x20000)).toBe(2) // CJK Unified Ext B
    expect(charWidth("😀".codePointAt(0) as number)).toBe(2) // U+1F600
  })

  it("counts combining diacritical / bidi / variation-selector marks as zero", () => {
    expect(charWidth(0x0301)).toBe(0) // combining acute accent
    expect(charWidth(0x200b)).toBe(0) // zero-width space
    expect(charWidth(0xfe0f)).toBe(0) // variation selector-16
    expect(charWidth(0xfeff)).toBe(0) // BOM / zero-width no-break space
  })

  it("splits conjoining Hangul Jamo: leading is wide, medial/final are zero-width", () => {
    // Decomposed 한 = choseong U+1112 + jungseong U+1161 + jongseong U+11AB.
    // Only the leading jamo advances the cursor; the vowel/final fold onto it.
    expect(charWidth(0x1112)).toBe(2) // choseong (leading)
    expect(charWidth(0x1161)).toBe(0) // jungseong (medial)
    expect(charWidth(0x11ab)).toBe(0) // jongseong (final)
    expect(charWidth(0x1160)).toBe(0) // jungseong filler (range floor)
    expect(charWidth(0x11ff)).toBe(0) // range ceiling
  })

  it("counts combining half marks (U+FE20–U+FE2F) as zero", () => {
    expect(charWidth(0xfe20)).toBe(0)
    expect(charWidth(0xfe26)).toBe(0) // combining conjoining macron
    expect(charWidth(0xfe2f)).toBe(0)
  })

  it("keeps the wide CJK-compatibility neighbours of the half-mark block intact", () => {
    expect(charWidth(0xfe19)).toBe(2) // presentation form for vertical horizontal ellipsis (0xfe10–0xfe19)
    expect(charWidth(0xfe30)).toBe(2) // CJK compatibility form (0xfe30–0xfe6f)
  })

  it("counts the Enclosed Ideographic Supplement block as two cells", () => {
    // Whole block (U+1F200–U+1F2FF) is East-Asian-Width = Wide; it sits just
    // below the emoji range and was previously counted as one cell.
    expect(charWidth(0x1f200)).toBe(2) // 🈀 square hiragana hoka
    expect(charWidth(0x1f21a)).toBe(2) // 🈚 squared CJK "no charge"
    expect(charWidth(0x1f22f)).toBe(2) // 🈯 squared CJK "reserved"
    expect(charWidth(0x1f250)).toBe(2) // 🉐 circled ideograph "advantage"
  })

  it("counts the isolated Mahjong / playing-card emoji as two cells", () => {
    expect(charWidth(0x1f004)).toBe(2) // 🀄 mahjong tile red dragon
    expect(charWidth(0x1f0cf)).toBe(2) // 🃏 playing card black joker
  })
})

describe("displayWidth", () => {
  it("is zero for the empty string", () => {
    expect(displayWidth("")).toBe(0)
  })

  it("sums cells across a mixed CJK / ASCII string", () => {
    expect(displayWidth("ab中c")).toBe(5) // 1 + 1 + 2 + 1
    expect(displayWidth("你好, world")).toBe(11) // 2 + 2 + rest ASCII (7)
  })

  it("measures decomposed (NFD) Hangul the same as precomposed", () => {
    // macOS filenames arrive NFD-decomposed; a Korean name in the file tree
    // or `kobe export` table must occupy the same width either way.
    const precomposed = "한글" // U+D55C U+AE00
    const decomposed = precomposed.normalize("NFD")
    expect(decomposed.length).toBeGreaterThan(precomposed.length) // genuinely decomposed
    expect(displayWidth(precomposed)).toBe(4)
    expect(displayWidth(decomposed)).toBe(4)
  })

  it("does not count a combining half mark as an extra cell", () => {
    expect(displayWidth("a︦")).toBe(1) // base glyph + zero-width mark
  })

  it("counts an astral character once, not as two UTF-16 units", () => {
    const ext = "𠀀" // U+20000, one wide code point stored as a surrogate pair
    expect(ext.length).toBe(2) // two UTF-16 units
    expect(displayWidth(ext)).toBe(2) // still two cells, not four
  })

  it("sums wide enclosed-ideograph glyphs over code points, not UTF-16 units", () => {
    expect(displayWidth("🈚x")).toBe(3) // wide (2) + ascii (1)
    expect(displayWidth("🀄🃏")).toBe(4)
  })
})
