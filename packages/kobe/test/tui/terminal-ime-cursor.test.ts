import { describe, expect, it } from "vitest"
import { ImeCursorRetention } from "../../src/tui/panes/terminal/ime-cursor"

describe("ImeCursorRetention", () => {
  it("retains the last visible PTY cursor through a transient hidden-cursor frame", () => {
    const tracker = new ImeCursorRetention()
    const pty = {}

    expect(tracker.update(pty, { x: 12, y: 4 })).toEqual({ x: 12, y: 4 })
    expect(tracker.update(pty, null)).toEqual({ x: 12, y: 4 })
  })

  it("clears a retained cursor when the PTY identity changes", () => {
    const tracker = new ImeCursorRetention()
    const firstPty = {}
    const nextPty = {}

    tracker.update(firstPty, { x: 12, y: 4 })

    expect(tracker.update(nextPty, null)).toBeNull()
    expect(tracker.update(nextPty, { x: 3, y: 1 })).toEqual({ x: 3, y: 1 })
  })

  it("clears the retained cursor when no PTY is active", () => {
    const tracker = new ImeCursorRetention()
    const pty = {}

    tracker.update(pty, { x: 12, y: 4 })

    expect(tracker.update(null, null)).toBeNull()
    expect(tracker.current()).toBeNull()
  })
})
