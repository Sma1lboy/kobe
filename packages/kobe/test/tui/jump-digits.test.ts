import { describe, expect, it } from "vitest"
import { SIDEBAR_BINDINGS } from "../../src/tui/context/keybindings-sidebar.ts"
import { TASK_JUMP_CHORDS, TASK_JUMP_DIGITS, taskJumpDigit } from "../../src/tui/panes/sidebar/jump-digits.ts"

/**
 * The whole point of printing the digit on the row is that the printed
 * digit IS the chord. These pin that identity from both ends — a chord
 * added to the table without a matching printed digit (or vice versa)
 * would strand a row you can see but can't reach.
 */
describe("task jump digits", () => {
  it("skips 1 — the legacy terminal protocol cannot encode ctrl+1", () => {
    expect(TASK_JUMP_DIGITS).not.toContain("1")
    expect(TASK_JUMP_DIGITS[0]).toBe("2")
    expect(TASK_JUMP_DIGITS.at(-1)).toBe("0")
  })

  it("row N prints the digit whose chord fires slot N", () => {
    const binding = SIDEBAR_BINDINGS.find((b) => b.id === "tasks.jump")
    expect(binding).toBeDefined()
    expect(binding?.keys).toEqual([...TASK_JUMP_CHORDS])
    for (let row = 0; row < TASK_JUMP_DIGITS.length; row++) {
      expect(`ctrl+${taskJumpDigit(row)}`).toBe(binding?.keys[row])
    }
  })

  it("rows past the last digit print nothing rather than a wrong digit", () => {
    expect(taskJumpDigit(TASK_JUMP_DIGITS.length)).toBeNull()
    expect(taskJumpDigit(99)).toBeNull()
  })
})
