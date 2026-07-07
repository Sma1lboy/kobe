/**
 * Pure CJK word-boundary math (`src/tui/lib/cjk-word.ts`).
 *
 * Why these tests matter: the functions operate in DISPLAY-COLUMN space —
 * the coordinate system of opentui's native edit buffer, probed against
 * @opentui/core 0.4.3 (CJK glyph = 2 cells, mid-glyph snaps down). A
 * regression here silently lands word jumps/deletes inside the wrong
 * character for every Chinese prompt, which is kobe's default language.
 * The prototype wiring (`cjk-word-patch.ts`) imports @opentui and can't run
 * under vitest; this pure layer is the tested contract.
 */

import { describe, expect, it } from "vitest"
import { colToIndex, indexToCol, nextWordCol, prevWordCol } from "../../src/tui/lib/cjk-word.ts"

describe("col/index conversion", () => {
  it("counts CJK as two cells, ASCII as one", () => {
    // "中文ab" → cols: 中=0..2, 文=2..4, a=4, b=5
    expect(indexToCol("中文ab", 0)).toBe(0)
    expect(indexToCol("中文ab", 1)).toBe(2)
    expect(indexToCol("中文ab", 2)).toBe(4)
    expect(indexToCol("中文ab", 4)).toBe(6)
    expect(colToIndex("中文ab", 4)).toBe(2)
    expect(colToIndex("中文ab", 6)).toBe(4)
  })

  it("snaps down inside a wide glyph (native edit-buffer rule)", () => {
    expect(colToIndex("中文", 1)).toBe(0)
    expect(colToIndex("中文", 3)).toBe(1)
  })

  it("clamps past end of line", () => {
    expect(colToIndex("ab", 99)).toBe(2)
  })
})

describe("nextWordCol", () => {
  it("jumps by Chinese word, not by whole CJK run", () => {
    // 中文|输入|法 — from 0 the first hop is after 中文 (col 4), not line end
    const line = "中文输入法"
    expect(nextWordCol(line, 0)).toBe(4)
    expect(nextWordCol(line, 4)).toBe(8)
  })

  it("treats ] and = as split points", () => {
    // "a]b=c" cols: a=0 ]=1 b=2 ==3 c=4
    const line = "a]b=c"
    expect(nextWordCol(line, 0)).toBe(1) // end of "a"
    expect(nextWordCol(line, 1)).toBe(2) // past "]"
    expect(nextWordCol(line, 2)).toBe(3) // end of "b"
    expect(nextWordCol(line, 3)).toBe(4) // past "="
  })

  it("treats fullwidth punctuation as split points", () => {
    // "任务】名" cols: 任=0..2 务=2..4 】=4..6 名=6..8
    const line = "任务】名"
    expect(nextWordCol(line, 0)).toBe(4) // end of 任务
    expect(nextWordCol(line, 4)).toBe(6) // past 】
    expect(nextWordCol(line, 6)).toBe(8)
  })

  it("consumes a punctuation run as one hop", () => {
    expect(nextWordCol("a]]==b", 1)).toBe(5) // whole "]]==" run
  })

  it("skips whitespace before the next word", () => {
    // "中文  输入" cols: 中文=0..4, spaces=4..6, 输入=6..10
    expect(nextWordCol("中文  输入", 4)).toBe(10)
  })

  it("returns line-end col when nothing follows (patch falls back to native)", () => {
    expect(nextWordCol("中文", 4)).toBe(4)
    expect(nextWordCol("中文  ", 4)).toBe(6) // trailing spaces → end of line
  })
})

describe("prevWordCol", () => {
  it("jumps back by Chinese word", () => {
    const line = "中文输入法"
    // 中文|输入|法 → from end (col 10) back to start of 法 (col 8)
    expect(prevWordCol(line, 10)).toBe(8)
    expect(prevWordCol(line, 8)).toBe(4)
    expect(prevWordCol(line, 4)).toBe(0)
  })

  it("stops at ] and = boundaries", () => {
    const line = "路径=值" // 路径=0..4, ==4..5, 值=5..7
    expect(prevWordCol(line, 7)).toBe(5) // start of 值
    expect(prevWordCol(line, 5)).toBe(4) // start of =
    expect(prevWordCol(line, 4)).toBe(0) // start of 路径
  })

  it("skips trailing whitespace, then deletes/moves one word", () => {
    // "中文 " cols: 中文=0..4, space=4..5
    expect(prevWordCol("中文 ", 5)).toBe(0)
  })

  it("consumes a punctuation run as one hop", () => {
    expect(prevWordCol("a]]==b", 5)).toBe(1)
  })

  it("returns 0 at or before the first word", () => {
    expect(prevWordCol("中文", 0)).toBe(0)
    expect(prevWordCol("  中文", 2)).toBe(0)
  })

  it("lands on word start when cursor is mid-word", () => {
    expect(prevWordCol("中文输入", 6)).toBe(4) // mid-输入 → start of 输入
  })
})

describe("mixed real-world prompt", () => {
  it("walks 'feat: 中文输入法优化(quick-task)' by word", () => {
    const line = "feat: 中文输入法优化(quick-task)"
    // forward from 0: feat | : | 中文 | 输入 | 法 | 优 | 化 | ( | quick | - | task | )
    const hops: number[] = []
    let col = 0
    for (let guard = 0; guard < 20; guard++) {
      const next = nextWordCol(line, col)
      if (next <= col) break
      hops.push(next)
      col = next
    }
    expect(hops[0]).toBe(4) // after "feat"
    expect(hops[hops.length - 1]).toBe(indexToCol(line, line.length))
    // every hop lands on a boundary that prevWordCol agrees with
    for (const h of hops.slice(0, -1)) {
      expect(nextWordCol(line, prevWordCol(line, h))).toBe(h)
    }
  })
})
