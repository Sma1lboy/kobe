/**
 * `makeDropdownWindow` (src/tui/chat/composer/dropdown-window.ts) is the
 * shared center-cursor windowing used by the mention + slash dropdowns
 * and now the Ctrl+R history palette. These assert the exact invariants
 * the palette used to reimplement inline, so the dedup keeps parity.
 */

import { describe, expect, test } from "vitest"
import { makeDropdownWindow } from "../../src/tui/chat/composer/dropdown-window"

const items = Array.from({ length: 20 }, (_, i) => i)

describe("makeDropdownWindow", () => {
  test("returns everything when the list fits", () => {
    const w = makeDropdownWindow([1, 2, 3], 0, 12)
    expect(w).toEqual({ items: [1, 2, 3], start: 0, total: 3 })
  })

  test("clamps the window to the top near the start", () => {
    const w = makeDropdownWindow(items, 1, 12)
    expect(w.start).toBe(0)
    expect(w.items).toHaveLength(12)
    expect(w.total).toBe(20)
  })

  test("centers the cursor mid-list", () => {
    const w = makeDropdownWindow(items, 10, 12)
    expect(w.start).toBe(4) // cursor - floor(12/2)
    expect(w.items[0]).toBe(4)
  })

  test("clamps the window to the bottom near the end", () => {
    const w = makeDropdownWindow(items, 19, 12)
    expect(w.start).toBe(8) // total - maxVisible
    expect(w.items.at(-1)).toBe(19)
  })
})
