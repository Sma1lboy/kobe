import { describe, expect, test, vi } from "vitest"
import { GG_CHORD_TIMEOUT_MS, createSidebarController } from "../../src/tui/panes/sidebar/controller"

function makeCtrl(ids: string[], startCursor = 0) {
  let cursor = startCursor
  const onSelect = vi.fn()
  let pendingTimeout: (() => void) | null = null
  const cancel = vi.fn(() => {
    pendingTimeout = null
  })
  const ctrl = createSidebarController({
    getCursor: () => cursor,
    setCursor: (n) => {
      cursor = n
    },
    getFlatIds: () => ids,
    onSelect,
    scheduleTimeout: (cb, ms) => {
      expect(ms).toBe(GG_CHORD_TIMEOUT_MS)
      pendingTimeout = cb
      return cancel
    },
  })
  return {
    ctrl,
    onSelect,
    cursor: () => cursor,
    fireTimeout: () => {
      pendingTimeout?.()
      pendingTimeout = null
    },
  }
}

describe("movement", () => {
  test("moveDown/moveUp step and clamp at both ends", () => {
    const { ctrl, cursor } = makeCtrl(["a", "b", "c"], 0)
    ctrl.moveDown()
    expect(cursor()).toBe(1)
    ctrl.moveDown()
    ctrl.moveDown()
    expect(cursor()).toBe(2)
    ctrl.moveUp()
    ctrl.moveUp()
    ctrl.moveUp()
    expect(cursor()).toBe(0)
  })

  test("cursor -1 (no selection) is treated as 0 for movement", () => {
    const { ctrl, cursor } = makeCtrl(["a", "b"], -1)
    ctrl.moveDown()
    expect(cursor()).toBe(1)
  })

  test("empty list: movement never touches the cursor", () => {
    const { ctrl, cursor } = makeCtrl([], 0)
    ctrl.moveDown()
    ctrl.moveUp()
    expect(cursor()).toBe(0)
  })
})

describe("selectCurrent", () => {
  test("fires onSelect with the id under the cursor", () => {
    const { ctrl, onSelect } = makeCtrl(["a", "b"], 1)
    ctrl.selectCurrent()
    expect(onSelect).toHaveBeenCalledWith("b")
  })

  test("out-of-range cursor (-1 or past end) is a no-op", () => {
    const under = makeCtrl(["a"], -1)
    under.ctrl.selectCurrent()
    expect(under.onSelect).not.toHaveBeenCalled()

    const over = makeCtrl(["a"], 5)
    over.ctrl.selectCurrent()
    expect(over.onSelect).not.toHaveBeenCalled()
  })
})

describe("g g chord", () => {
  test("second g within the window jumps to top and disarms", () => {
    const { ctrl, cursor } = makeCtrl(["a", "b", "c"], 2)
    ctrl.pressG()
    expect(ctrl.isChordArmed()).toBe(true)
    ctrl.pressG()
    expect(cursor()).toBe(0)
    expect(ctrl.isChordArmed()).toBe(false)
  })

  test("the chord expires after the timeout — a late second g only re-arms", () => {
    const { ctrl, cursor, fireTimeout } = makeCtrl(["a", "b", "c"], 2)
    ctrl.pressG()
    fireTimeout()
    expect(ctrl.isChordArmed()).toBe(false)
    ctrl.pressG()
    expect(cursor()).toBe(2)
    expect(ctrl.isChordArmed()).toBe(true)
  })

  test("any other navigation disarms a pending chord (vim semantics)", () => {
    const { ctrl } = makeCtrl(["a", "b"], 0)
    ctrl.pressG()
    ctrl.moveDown()
    expect(ctrl.isChordArmed()).toBe(false)

    ctrl.pressG()
    ctrl.pressShiftG()
    expect(ctrl.isChordArmed()).toBe(false)

    ctrl.pressG()
    ctrl.disarmChord()
    expect(ctrl.isChordArmed()).toBe(false)
  })

  test("Shift+G jumps to the bottom", () => {
    const { ctrl, cursor } = makeCtrl(["a", "b", "c"], 0)
    ctrl.pressShiftG()
    expect(cursor()).toBe(2)
  })

  test("gg / Shift+G on an empty list never move the cursor", () => {
    const { ctrl, cursor } = makeCtrl([], 0)
    ctrl.pressG()
    ctrl.pressG()
    ctrl.pressShiftG()
    expect(cursor()).toBe(0)
  })
})
