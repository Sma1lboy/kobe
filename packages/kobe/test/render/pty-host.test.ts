/**
 * PtyHost — daemon-hosted PTY sessions (protocol v4).
 *
 * Why these tests matter: this is the tmux-persistence replacement. The
 * load-bearing behaviors are (1) a session SURVIVES every client
 * detaching — that's "quit the TUI, engine keeps running" — and (2) a
 * reattach replays the ring buffer so the new TUI repaints the screen.
 * Both are exercised against a real Bun PTY child (`cat`, which echoes
 * its input back through the PTY), not a mock — the spawn/terminal
 * plumbing is exactly what production runs.
 *
 * Lives in test/render (the bun-test-only track) although it renders
 * nothing: `Bun.spawn(..., { terminal })` needs the BUN runtime, and the
 * vitest pools run under Node.
 */

import { afterEach, describe, expect, test } from "bun:test"
import type { DaemonFrame } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { PtyHost, scanOscTitle } from "@sma1lboy/kobe-daemon/daemon/pty-host"

const ESC = "\x1b"
const BEL = "\x07"

const hosts: PtyHost[] = []

function makeHost(opts: ConstructorParameters<typeof PtyHost>[0] = {}): PtyHost {
  const host = new PtyHost(opts)
  hosts.push(host)
  return host
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.killAll()
})

function collector(): { frames: DaemonFrame[]; sink: (frame: DaemonFrame) => void } {
  const frames: DaemonFrame[] = []
  return { frames, sink: (frame) => frames.push(frame) }
}

function dataText(frames: DaemonFrame[]): string {
  let out = ""
  for (const frame of frames) {
    if (frame.type === "event" && frame.name === "pty.data") {
      out += Buffer.from((frame.payload as { data: string }).data, "base64").toString("utf8")
    }
  }
  return out
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 20))
  }
}

const SPEC = { cwd: process.cwd(), command: ["/bin/cat"], cols: 40, rows: 10 }

describe("PtyHost", () => {
  test("streams child output to the attached sink", async () => {
    const host = makeHost()
    const { frames, sink } = collector()
    const res = host.open("t1::tab1", SPEC, {}, sink)
    expect(res.alive).toBe(true)
    host.write("t1::tab1", "hello\n")
    // cat echoes through the PTY (with the tty's own echo too).
    await until(() => dataText(frames).includes("hello"))
  })

  test("session survives detach and replays on reattach", async () => {
    const host = makeHost()
    const a = collector()
    const tokenA = {}
    host.open("t1::tab1", SPEC, tokenA, a.sink)
    host.write("t1::tab1", "persist-me\n")
    await until(() => dataText(a.frames).includes("persist-me"))

    // Every client detaches — the "TUI quit" moment. Child must keep running.
    host.detachClient(tokenA)
    expect(host.list()).toMatchObject([{ key: "t1::tab1", alive: true }])

    // Fresh client reattaches: replay carries the earlier output, and the
    // live stream still works.
    const b = collector()
    const res = host.open("t1::tab1", SPEC, {}, b.sink)
    expect(res.alive).toBe(true)
    expect(Buffer.from(res.replay, "base64").toString("utf8")).toContain("persist-me")
    host.write("t1::tab1", "after-reattach\n")
    await until(() => dataText(b.frames).includes("after-reattach"))
  })

  test("kill ends the child, notifies sinks, and forgets the session", async () => {
    let ended = 0
    const host = makeHost({ onSessionEnd: () => ended++ })
    const { frames, sink } = collector()
    host.open("t1::tab1", SPEC, {}, sink)
    host.kill("t1::tab1")
    await until(() => frames.some((f) => f.type === "event" && f.name === "pty.exit"))
    expect(host.list()).toEqual([])
    expect(ended).toBe(1)
    // A live session is the host process's reason to stay up; none left.
    expect(host.liveCount()).toBe(0)
  })

  test("sweepTasks kills sessions whose task is archived/gone", async () => {
    const host = makeHost()
    host.open("live-task::tab1", SPEC, {}, collector().sink)
    host.open("dead-task::tab1", SPEC, {}, collector().sink)
    host.sweepTasks(new Set(["live-task"]))
    expect(host.list()).toMatchObject([{ key: "live-task::tab1", alive: true }])
  })

  test("live sessions count toward liveCount, exited ones don't", async () => {
    const host = makeHost()
    const { frames, sink } = collector()
    host.open("t1::tab1", { ...SPEC, command: ["/bin/sh", "-c", "exit 0"] }, {}, sink)
    await until(() => frames.some((f) => f.type === "event" && f.name === "pty.exit"))
    expect(host.liveCount()).toBe(0)
    // The exited session is KEPT (scrollback for a reattach) until killed.
    expect(host.list()).toMatchObject([{ key: "t1::tab1", alive: false }])
  })

  // Why this matters: pty.list's `title` is how headless surfaces
  // (`kobe api pty-list`) see each child's live process name without a TUI
  // attached — the same OSC 0/2 stream the tab strip renders. Last title
  // wins, and pid/command ride along for inventory.
  test("tracks the child's last OSC window title in list()", async () => {
    const host = makeHost()
    host.open(
      "t1::tab1",
      { ...SPEC, command: ["/bin/sh", "-c", `printf '\\033]2;first\\007'; printf '\\033]0;实时进程\\007'; cat`] },
      {},
      collector().sink,
    )
    await until(() => host.list()[0]?.title === "实时进程")
    const row = host.list()[0]
    expect(row).toMatchObject({ key: "t1::tab1", alive: true, title: "实时进程" })
    expect(typeof row?.pid).toBe("number")
    expect(row?.command[0]).toBe("/bin/sh")
  })
})

// The pure title/carry fold behind scanTitle. Driving this directly (instead
// of through a real PTY) is the only way to pin CROSS-CHUNK carry, because a
// real child's writes don't split at attacker-chosen byte boundaries — yet a
// PTY read boundary can fall anywhere, including inside a title's terminator.
describe("scanOscTitle", () => {
  test("captures a BEL- and an ST-terminated title in one chunk", () => {
    expect(scanOscTitle("", `${ESC}]0;bel${BEL}`)).toEqual({ title: "bel", carry: "" })
    expect(scanOscTitle("", `${ESC}]2;st${ESC}\\`)).toEqual({ title: "st", carry: "" })
  })

  test("last title in the chunk wins", () => {
    const r = scanOscTitle("", `${ESC}]2;first${BEL}output${ESC}]0;second${BEL}`)
    expect(r).toEqual({ title: "second", carry: "" })
  })

  test("no title closed → null title, so the caller keeps the old one", () => {
    expect(scanOscTitle("", "plain output, no escapes").title).toBeNull()
    // A color reset must not be mistaken for (or strand) a title.
    expect(scanOscTitle("", `text ${ESC}[0m more`)).toEqual({ title: null, carry: "" })
  })

  test("a title split mid-body across chunks completes on the next chunk", () => {
    const first = scanOscTitle("", `${ESC}]0;my-ti`)
    expect(first.title).toBeNull()
    expect(first.carry).toBe(`${ESC}]0;my-ti`)
    expect(scanOscTitle(first.carry, `tle${BEL}`)).toEqual({ title: "my-title", carry: "" })
  })

  // Regression: the ST terminator (ESC "\") can split across a PTY read
  // boundary. The pre-fix carry used lastIndexOf(ESC), which returned the
  // terminator's lone ESC and dropped the whole `ESC ]0;title` introducer —
  // the title was lost. The carry must anchor on the introducer instead.
  test("a title whose ST terminator splits across chunks is still captured", () => {
    const first = scanOscTitle("", `${ESC}]0;split-st${ESC}`)
    expect(first.title).toBeNull()
    expect(first.carry).toBe(`${ESC}]0;split-st${ESC}`)
    expect(scanOscTitle(first.carry, "\\")).toEqual({ title: "split-st", carry: "" })
  })

  test("a title whose introducer splits across chunks is still captured", () => {
    const first = scanOscTitle("", `done${ESC}`)
    expect(first).toEqual({ title: null, carry: ESC })
    expect(scanOscTitle(first.carry, `]2;boot${BEL}`)).toEqual({ title: "boot", carry: "" })
  })

  test("carry anchors on the introducer, not a later bare ESC", () => {
    // An in-progress title with the ST terminator's ESC arrived: the carry must
    // keep the whole `ESC ]0;…` introducer, not just the trailing lone ESC that
    // lastIndexOf(ESC) would have stranded.
    const { carry } = scanOscTitle("", `${ESC}]0;anchored${ESC}`)
    expect(carry).toBe(`${ESC}]0;anchored${ESC}`)
  })
})
