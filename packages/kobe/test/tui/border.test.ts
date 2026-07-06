/**
 * Contract test for `src/tui/component/border.ts` — the framework-free
 * border presets shared by the Solid and React composer views (issue #15
 * G3). The values are terminal grammar: `SplitBorder`'s heavy `┃` and
 * `EmptyBorder`'s all-blank charset are what make the composer rail and the
 * pane separators read correctly, so a drive-by edit should fail a test,
 * not surface as a subtly wrong glyph across every pane.
 */

import { describe, expect, test } from "vitest"
import { EmptyBorder, HSplitBorder, SplitBorder } from "../../src/tui/component/border"

describe("border presets", () => {
  test("EmptyBorder draws no chrome (only the horizontal space filler)", () => {
    expect(EmptyBorder.horizontal).toBe(" ")
    const { horizontal, ...rest } = EmptyBorder
    expect(Object.values(rest).every((ch) => ch === "")).toBe(true)
  })

  test("SplitBorder is a heavy vertical rule on the left/right edges", () => {
    expect(SplitBorder.border).toEqual(["left", "right"])
    expect(SplitBorder.customBorderChars.vertical).toBe("┃")
    // Everything else stays EmptyBorder — the rail is the ONLY chrome.
    expect(SplitBorder.customBorderChars.topLeft).toBe("")
  })

  test("HSplitBorder is the heavy horizontal sibling", () => {
    expect(HSplitBorder.customBorderChars.horizontal).toBe("━")
    expect(HSplitBorder.customBorderChars.vertical).toBe("")
  })
})
