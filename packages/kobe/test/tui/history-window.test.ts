import { describe, expect, test } from "vitest"
import { RENDER_WINDOW, windowTail } from "../../src/tui/history/window.ts"

describe("windowTail", () => {
  test("short list passes through untouched, no indicator", () => {
    const list = ["a", "b", "c"]
    const w = windowTail(list, 5)
    expect(w.hiddenCount).toBe(0)
    expect(w.visible).toBe(list)
  })

  test("exactly at the cap is not windowed", () => {
    const list = [1, 2, 3]
    const w = windowTail(list, 3)
    expect(w.hiddenCount).toBe(0)
    expect(w.visible).toBe(list)
  })

  test("over the cap keeps the newest tail and counts the elided head", () => {
    const list = Array.from({ length: 10 }, (_, i) => i)
    const w = windowTail(list, 4)
    expect(w.hiddenCount).toBe(6)
    expect(w.visible).toEqual([6, 7, 8, 9])
  })

  test("empty list", () => {
    const w = windowTail([], 4)
    expect(w.hiddenCount).toBe(0)
    expect(w.visible).toEqual([])
  })

  test("default cap is RENDER_WINDOW", () => {
    const list = Array.from({ length: RENDER_WINDOW + 7 }, (_, i) => i)
    const w = windowTail(list)
    expect(w.hiddenCount).toBe(7)
    expect(w.visible.length).toBe(RENDER_WINDOW)
    expect(w.visible[w.visible.length - 1]).toBe(RENDER_WINDOW + 6)
  })
})
