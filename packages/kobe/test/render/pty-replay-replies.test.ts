/**
 * Ring-buffer replay must not re-answer the child's PAST terminal queries.
 *
 * A reattach feeds the host's replay into a fresh xterm; the replayed
 * stream contains queries (DSR `ESC[6n`, DA `ESC[c`) the child asked long
 * ago. Answering them again injects unsolicited CPR/DA bytes into the
 * child's stdin — an interactive claude read them as input and scrambled
 * its renderer. Live queries after the replay must still be answered:
 * dropping those is the OTHER historical bug (half-erased input-box rule).
 */

import { describe, expect, it } from "bun:test"
import type { TaskPtyOpts } from "../../src/tui/panes/terminal/pty-types"
import { XtermTaskPty } from "../../src/tui/panes/terminal/pty-xterm-base"

class ProbeTaskPty extends XtermTaskPty {
  readonly writes: string[] = []
  protected transportWrite(data: string): void {
    this.writes.push(data)
  }
  protected transportResize(): void {}
  protected transportKill(): void {}
  feedLive(data: string): void {
    this.feed(data)
  }
  replay(data: string): void {
    this.feedReplay(data)
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the raw ESC-prefixed CPR reply is the whole point
const CPR = /\x1b\[\d+;\d+R/

function screenText(pty: ProbeTaskPty): string {
  return pty
    .capture()
    .map((row) => row.map((c) => c.text).join(""))
    .join("\n")
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(cond()).toBe(true)
}

function probe(): ProbeTaskPty {
  const opts: TaskPtyOpts = { taskId: "t1", cwd: "/tmp", cols: 40, rows: 6 }
  return new ProbeTaskPty(opts)
}

describe("XtermTaskPty replay reply muting", () => {
  it("mutes replies while parsing a replay, then answers live queries again", async () => {
    const pty = probe()
    pty.replay("past \x1b[6n output")
    pty.feedLive("live \x1b[6n tail")
    await until(() => screenText(pty).includes("tail"))
    const replies = pty.writes.filter((w) => CPR.test(w))
    expect(replies).toHaveLength(1)
  })

  it("keeps answering a purely live stream (no replay involved)", async () => {
    const pty = probe()
    pty.feedLive("hello \x1b[6n world")
    await until(() => screenText(pty).includes("world"))
    expect(pty.writes.filter((w) => CPR.test(w))).toHaveLength(1)
  })
})
