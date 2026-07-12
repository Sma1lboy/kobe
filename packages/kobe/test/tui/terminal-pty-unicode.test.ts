import { describe, expect, it } from "vitest"
import { charWidth } from "../../src/lib/display-width"
import { XtermTaskPty } from "../../src/tui/panes/terminal/pty-xterm-base"

/**
 * Unicode 11 width tables (regression pin for the Unicode11Addon wiring).
 *
 * Why this matters: @xterm/headless defaults to Unicode 6, where emoji are
 * ONE cell wide — but engines (claude/codex) and kobe's own cursor-overlay
 * math (`lib/display-width.ts`) measure them as TWO. Any emoji in engine
 * output desynced the emulator's cursor/wrap from the drawn overlay, the
 * same "cursor doesn't follow the text" failure class as the CJK bug.
 */

class FakeTransportPty extends XtermTaskPty {
  protected transportWrite(_data: string): void {}
  protected transportResize(_cols: number, _rows: number): void {}
  protected transportKill(): void {}
  pump(data: string): void {
    this.feed(data)
  }
}

function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("XtermTaskPty unicode widths", () => {
  it("measures emoji as two cells, matching the overlay's charWidth table", async () => {
    const pty = new FakeTransportPty({ taskId: "t1", cwd: "/wt", cols: 40, rows: 6, scrollback: 10 })
    pty.onData(() => {})

    pty.pump("🚀x")
    await settle()

    // Overlay math says 🚀 is 2 cells; the emulator's cursor must agree
    // (1 emoji cell-pair + 1 ascii = column 3), or the drawn cursor drifts.
    expect(charWidth(0x1f680)).toBe(2)
    expect(pty.captureCursor()).toEqual({ x: 3, y: 0 })
    pty.kill()
  })
})
