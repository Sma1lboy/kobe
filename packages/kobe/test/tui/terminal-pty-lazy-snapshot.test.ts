import { describe, expect, it, vi } from "vitest"
import type { TerminalRow } from "../../src/tui/panes/terminal/pty-types"
import { XtermTaskPty } from "../../src/tui/panes/terminal/pty-xterm-base"

/**
 * Lazy snapshot rebuild for unwatched PTYs.
 *
 * Why this matters: the workspace keeps every task's engine PTYs alive in
 * the registry, but only the visible tab subscribes via `onData`. Before
 * the lazy path, EVERY live PTY re-converted its full grid + 200-row
 * scrollback margin at output cadence (~60Hz) even though its only reader
 * was the 1.5s turn-status poll's `capture()` — N background streaming
 * sessions burned N× a full-screen conversion for nothing. These tests pin
 * the contract: no subscriber → no eager rebuild; `capture()` and a late
 * `onData` subscribe still always see fresh content.
 */

class FakeTransportPty extends XtermTaskPty {
  protected transportWrite(_data: string): void {}
  protected transportResize(_cols: number, _rows: number): void {}
  protected transportKill(): void {}
  pump(data: string): void {
    this.feed(data)
  }
}

function rowsText(rows: readonly TerminalRow[]): string {
  return rows.map((row) => row.map((chunk) => chunk.text).join("")).join("\n")
}

/** Let xterm's async write callback + the 16ms refresh debounce drain. */
function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("XtermTaskPty lazy snapshot (no subscribers)", () => {
  it("defers the rebuild until capture(), then serves it without re-converting", async () => {
    const pty = new FakeTransportPty({ taskId: "t1", cwd: "/wt" })
    // biome-ignore lint/suspicious/noExplicitAny: reaching a private method to observe laziness
    const refresh = vi.spyOn(pty as any, "refreshSnapshot")

    pty.pump("hello from background\r\n")
    await settle()
    // Output landed but nobody is watching — no conversion ran.
    expect(refresh).not.toHaveBeenCalled()

    // The turn poll's read path: capture() rebuilds once, lazily.
    expect(rowsText(pty.capture())).toContain("hello from background")
    expect(refresh).toHaveBeenCalledTimes(1)

    // Clean now — a second read doesn't rebuild again.
    pty.capture()
    pty.captureCursor()
    expect(refresh).toHaveBeenCalledTimes(1)

    pty.kill()
  })

  it("primes a late onData subscriber with fresh content, not the stale snapshot", async () => {
    const pty = new FakeTransportPty({ taskId: "t1", cwd: "/wt" })
    pty.pump("first output\r\n")
    await settle()

    const primed: string[] = []
    pty.onData((snap) => primed.push(rowsText(snap)))
    expect(primed).toHaveLength(1)
    expect(primed[0]).toContain("first output")

    pty.kill()
  })

  it("keeps the eager push path for live subscribers", async () => {
    const pty = new FakeTransportPty({ taskId: "t1", cwd: "/wt" })
    const seen: string[] = []
    pty.onData((snap) => seen.push(rowsText(snap)))

    pty.pump("streamed line\r\n")
    await settle()
    // No capture() needed — the subscriber was pushed the fresh snapshot.
    expect(seen.some((s) => s.includes("streamed line"))).toBe(true)

    pty.kill()
  })
})
