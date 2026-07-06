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
    expect(SplitBorder.customBorderChars.topLeft).toBe("")
  })

  test("HSplitBorder is the heavy horizontal sibling", () => {
    expect(HSplitBorder.customBorderChars.horizontal).toBe("━")
    expect(HSplitBorder.customBorderChars.vertical).toBe("")
  })
})
