import { describe, expect, it } from "vitest"
import { MockTaskPty } from "../../src/tui/panes/terminal/pty-mock"
import { extractOscTitle } from "../../src/tui/panes/terminal/pty-types"

describe("extractOscTitle", () => {
  it("reads OSC 0 and OSC 2 title payloads, BEL- or ST-terminated", () => {
    expect(extractOscTitle("hello \x1b]0;my cool title\x07 world")).toBe("my cool title")
    expect(extractOscTitle("\x1b]2;vim\x1b\\")).toBe("vim")
  })

  it("returns the LAST title escape when a chunk carries more than one", () => {
    expect(extractOscTitle("\x1b]2;first\x07 then \x1b]2;second\x07")).toBe("second")
  })

  it("returns null when the chunk has no title escape", () => {
    expect(extractOscTitle("just plain output\n")).toBeNull()
  })
})

describe("MockTaskPty.onTitleChange", () => {
  it("fires on a new title, replays the latest on a late subscribe, and dedupes repeats", () => {
    const pty = new MockTaskPty({ taskId: "t1", cwd: "/wt" })
    const seen: string[] = []
    pty.onTitleChange((t) => seen.push(t))
    pty.feed("prompt$ \x1b]2;vim\x07")
    expect(seen).toEqual(["vim"])
    // A late subscriber immediately gets the current title (same replay
    // contract as `onData`/`onExit`).
    const late: string[] = []
    pty.onTitleChange((t) => late.push(t))
    expect(late).toEqual(["vim"])
    // Feeding the SAME title again is a no-op — no duplicate notification.
    pty.feed("\x1b]2;vim\x07")
    expect(seen).toEqual(["vim"])
    // A genuinely new title does fire.
    pty.feed("\x1b]2;htop\x07")
    expect(seen).toEqual(["vim", "htop"])
  })
})
