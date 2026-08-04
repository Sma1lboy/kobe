import { describe, expect, it } from "vitest"
import { KEYBOARD_COACH_DONE, nextKeyboardCoachStep } from "../../src/tui/lib/keyboard-coach"

describe("keyboard coach", () => {
  it("advances only after the gesture taught by each step", () => {
    expect(nextKeyboardCoachStep(0, { focused: "sidebar", lastAction: null, lastWasPrefix: false })).toBe(0)
    expect(nextKeyboardCoachStep(0, { focused: "workspace", lastAction: null, lastWasPrefix: false })).toBe(1)
    expect(nextKeyboardCoachStep(1, { focused: "sidebar", lastAction: "chat.tab.new", lastWasPrefix: false })).toBe(1)
    expect(nextKeyboardCoachStep(1, { focused: "sidebar", lastAction: "focus.sidebar", lastWasPrefix: false })).toBe(2)
    expect(nextKeyboardCoachStep(2, { focused: "sidebar", lastAction: "chat.fork.new", lastWasPrefix: true })).toBe(
      KEYBOARD_COACH_DONE,
    )
  })

  it("does not complete the prefix step from a direct shortcut", () => {
    expect(nextKeyboardCoachStep(2, { focused: "sidebar", lastAction: "chat.tab.new", lastWasPrefix: false })).toBe(2)
  })
})
