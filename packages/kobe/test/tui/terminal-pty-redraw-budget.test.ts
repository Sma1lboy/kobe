import { describe, expect, it, vi } from "vitest"
import type { CursorPos, TerminalRow } from "../../src/tui/panes/terminal/pty-types"
import { XtermTaskPty } from "../../src/tui/panes/terminal/pty-xterm-base"
import { xtermLineToChunks } from "../../src/tui/panes/terminal/xterm-chunks"

vi.mock("../../src/tui/panes/terminal/xterm-chunks", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/tui/panes/terminal/xterm-chunks")>()
  return { ...mod, xtermLineToChunks: vi.fn(mod.xtermLineToChunks) }
})

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

function makePty(): FakeTransportPty {
  return new FakeTransportPty({ taskId: "t1", cwd: "/wt", cols: 40, rows: 10, scrollback: 20 })
}

/** Regression pin for the unconditional terminal refresh path introduced by 4562c600. */
describe("XtermTaskPty redraw budget", () => {
  it("does not publish parsed control traffic when the rendered state is unchanged", async () => {
    const pty = makePty()
    const onData = vi.fn()
    const onTitle = vi.fn()
    pty.onData(onData)
    pty.onTitleChange(onTitle)

    pty.pump("seed")
    await settle()
    const before = pty.capture()
    onData.mockClear()
    onTitle.mockClear()
    vi.mocked(xtermLineToChunks).mockClear()

    pty.pump("\x1b]2;vim\x07")
    await settle()
    expect(onTitle).toHaveBeenCalledWith("vim")
    expect(onData).not.toHaveBeenCalled()
    expect(pty.capture()).toBe(before)

    pty.pump("\x1b[1;5H")
    await settle()
    expect(onData).not.toHaveBeenCalled()
    expect(pty.capture()).toBe(before)

    pty.pump("\x1b[?2026h\x1b[1;5H\x1b[?2026l")
    await settle()
    expect(onData).not.toHaveBeenCalled()
    expect(pty.capture()).toBe(before)
    expect(xtermLineToChunks).not.toHaveBeenCalled()

    pty.kill()
  })

  /**
   * The frozen-scrollback fast path in `dirtyRowsMatchSnapshot` skips
   * re-deriving rows below `baseY` that the rebuild path already cached under
   * an absolute line id. Its one hazard: once the window saturates,
   * `baseY`/`length`/`start` all stay CONSTANT while content scrolls, so
   * `sameMeta` cannot see the move — only the absolute-id identity compare
   * can. If that compare ever went away, a saturated buffer would publish a
   * stale window forever.
   */
  it("still detects a shift once the scrollback window is saturated", async () => {
    const pty = makePty() // rows 10 + scrollback 20 -> saturates at 30 lines
    const text = (rows: readonly TerminalRow[]) => rows.map((r) => r.map((c) => c.text).join("")).join("\n")

    for (let i = 0; i < 60; i++) pty.pump(`line-${i}\r\n`)
    await settle()
    const saturated = pty.capture()
    expect(text(saturated)).toContain("line-59")
    const topBefore = text(saturated).split("\n")[0]

    // A sync-marked frame, which is what forces dirty={kind:"all"} — exactly
    // the case the fast path short-circuits.
    pty.pump("\x1b[?2026hline-60\r\n\x1b[?2026l")
    await settle()

    const shifted = pty.capture()
    expect(shifted).not.toBe(saturated)
    expect(text(shifted)).toContain("line-60")
    expect(text(shifted).split("\n")[0]).not.toBe(topBefore)
    pty.kill()
  })

  it("publishes real text changes exactly once", async () => {
    const pty = makePty()
    const onData = vi.fn<(rows: readonly TerminalRow[], cursor: CursorPos | null) => void>()
    pty.onData(onData)

    pty.pump("seed")
    await settle()
    const before = pty.capture()
    onData.mockClear()

    pty.pump("!")
    await settle()

    expect(onData).toHaveBeenCalledTimes(1)
    expect(pty.capture()).not.toBe(before)
    pty.kill()
  })

  it("publishes style-only cell changes", async () => {
    const pty = makePty()
    const onData = vi.fn()
    pty.onData(onData)

    pty.pump("A")
    await settle()
    const before = pty.capture()
    onData.mockClear()

    pty.pump("\r\x1b[31mA")
    await settle()

    expect(onData).toHaveBeenCalledTimes(1)
    expect(pty.capture()).not.toBe(before)
    expect(pty.capture()[0]?.[0]?.fg).toBeDefined()
    pty.kill()
  })

  it("publishes cursor-only changes while preserving snapshot identity", async () => {
    const pty = makePty()
    const seen: Array<{ rows: readonly TerminalRow[]; cursor: CursorPos | null }> = []
    pty.onData((rows, cursor) => seen.push({ rows, cursor }))

    pty.pump("seed")
    await settle()
    const before = pty.capture()
    seen.length = 0

    pty.pump("\x1b[D")
    await settle()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.rows).toBe(before)
    expect(seen[0]?.cursor).toEqual({ x: 3, y: 0 })
    pty.kill()
  })

  it("publishes cursor visibility changes without inventing row changes", async () => {
    const pty = makePty()
    const seen: Array<{ rows: readonly TerminalRow[]; cursor: CursorPos | null }> = []
    pty.onData((rows, cursor) => seen.push({ rows, cursor }))

    pty.pump("seed")
    await settle()
    const before = pty.capture()
    seen.length = 0

    pty.pump("\x1b[?25l")
    await settle()
    expect(seen).toEqual([{ rows: before, cursor: null }])

    const hiddenRows = pty.capture()
    seen.length = 0
    pty.pump("\x1b[10C")
    await settle()
    expect(seen).toHaveLength(0)
    expect(pty.capture()).toBe(hiddenRows)

    pty.pump("\x1b[?25h")
    await settle()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.cursor).toEqual({ x: 14, y: 0 })
    pty.kill()
  })
})
