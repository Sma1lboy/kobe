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
import { PtyHost, foldOscTitle } from "@sma1lboy/kobe-daemon/daemon/pty-host"

const hosts: PtyHost[] = []

function makeHost(opts: ConstructorParameters<typeof PtyHost>[0] = {}): PtyHost {
  const host = new PtyHost(opts)
  hosts.push(host)
  return host
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.killAll()))
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

function withOuterTerminalIdentity<T>(run: () => T): T {
  const program = process.env.TERM_PROGRAM
  const version = process.env.TERM_PROGRAM_VERSION
  process.env.TERM_PROGRAM = "iTerm.app"
  process.env.TERM_PROGRAM_VERSION = "3.6.11"
  try {
    return run()
  } finally {
    if (program === undefined) Reflect.deleteProperty(process.env, "TERM_PROGRAM")
    else process.env.TERM_PROGRAM = program
    if (version === undefined) Reflect.deleteProperty(process.env, "TERM_PROGRAM_VERSION")
    else process.env.TERM_PROGRAM_VERSION = version
  }
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 20))
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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

  test("reports parked-screen retention and exact-delta versus fallback wakes", async () => {
    const host = makeHost({ scrollbackCap: 32 })
    const firstToken = {}
    const first = host.open("t1::tab1", SPEC, firstToken, collector().sink)
    host.write("t1::tab1", "one\n")
    await until(() => host.stats().ringBytes > 0)
    host.detach("t1::tab1", firstToken, true, 1234)

    expect(host.list()).toMatchObject([{ key: "t1::tab1", parked: true, parkedScreenBytes: 1234 }])
    expect(host.stats()).toMatchObject({ parkedSessions: 1, parkedScreenBytes: 1234 })

    const secondToken = {}
    host.open("t1::tab1", SPEC, secondToken, collector().sink, first.offset, first.pid ?? undefined)
    expect(host.stats()).toMatchObject({ parkedSessions: 0, parkRestoreDeltas: 1, parkRestoreFallbacks: 0 })

    host.detach("t1::tab1", secondToken, true, 99)
    host.open("t1::tab1", SPEC, {}, collector().sink, 0, -1)
    expect(host.stats().parkRestoreFallbacks).toBe(1)
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

  test("kill escalates past a PTY child that ignores TERM and HUP", async () => {
    const host = makeHost()
    const { frames, sink } = collector()
    const res = host.open(
      "t1::stubborn",
      {
        ...SPEC,
        command: ["/bin/sh", "-c", "trap '' HUP TERM; echo ready; while :; do sleep 1; done"],
      },
      {},
      sink,
    )
    const pid = res.pid
    expect(pid).not.toBeNull()
    if (pid === null) throw new Error("expected PTY child pid")
    try {
      await until(() => dataText(frames).includes("ready"))
      host.kill("t1::stubborn")
      await until(() => !isAlive(pid), 1500)
      expect(host.list()).toEqual([])
    } finally {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        /* already gone */
      }
    }
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

  // Why: `created` is the client's cue that its typed engine line
  // (`initialInput`) belongs to this open — resending it on reattach
  // would run the engine command twice in the same shell.
  test("open() reports created on fresh spawn, not on reattach", () => {
    const host = makeHost()
    expect(host.open("t1::tab1", SPEC, {}, collector().sink).created).toBe(true)
    expect(host.open("t1::tab1", SPEC, {}, collector().sink).created).toBe(false)
  })

  // Why: the warm slot is the "pre-initialized shell" ask (2026-07-10) —
  // an engine tab must adopt the ALREADY-RUNNING spare (same pid) instead
  // of paying shell startup, a replacement must be warmed right away, and
  // the spare must never pin the host open (liveCount) or show in list().
  test("warm shell: adopted by a matching open, invisible otherwise", async () => {
    let started = 0
    const host = makeHost({ onSessionStart: () => started++ })
    host.warm(process.cwd(), "/bin/cat", 40, 10)
    expect(host.liveCount()).toBe(0)
    expect(host.list()).toEqual([])
    expect(started).toBe(0)

    // Matching open (same cwd, bare-shell argv) adopts the spare…
    const first = host.open("t1::tab1", { ...SPEC, command: ["/bin/cat"] }, {}, collector().sink)
    expect(first.created).toBe(true)
    expect(started).toBe(1)
    // …and a replacement spare exists: the next open adopts a DIFFERENT pid.
    const second = host.open("t1::tab2", { ...SPEC, command: ["/bin/cat"] }, {}, collector().sink)
    expect(second.created).toBe(true)
    expect(second.pid).not.toBe(first.pid)

    // The adopted session behaves like any other: input flows, list shows it.
    const { frames, sink } = collector()
    host.open("t1::tab1", { ...SPEC, command: ["/bin/cat"] }, {}, sink)
    host.write("t1::tab1", "warm-adopt\n")
    await until(() => dataText(frames).includes("warm-adopt"))

    // A spec that doesn't match the spare (different cwd) spawns fresh.
    const spareBefore = host.liveCount()
    const other = host.open("t2::tab1", { ...SPEC, cwd: "/", command: ["/bin/cat"] }, {}, collector().sink)
    expect(other.created).toBe(true)
    expect(host.liveCount()).toBe(spareBefore + 1)

    // killAll ends the spare too — nothing survives host shutdown.
    await host.killAll()
    expect(host.liveCount()).toBe(0)
  })

  test("does not leak the outer terminal emulator identity to hosted children", async () => {
    const host = makeHost()
    const { frames, sink } = collector()
    withOuterTerminalIdentity(() => {
      host.open(
        "t1::env",
        {
          ...SPEC,
          command: [
            "/bin/sh",
            "-c",
            'printf "program=%s version=%s\\n" "${TERM_PROGRAM-unset}" "${TERM_PROGRAM_VERSION-unset}"; sleep 1',
          ],
        },
        {},
        sink,
      )
    })

    await until(() => dataText(frames).includes("program="))
    expect(dataText(frames)).toContain("program=unset version=unset")
  })
})

// The pure title/carry fold behind scanOscTitle. Driving this directly
// (instead of through a real PTY) is the only way to pin CROSS-CHUNK carry:
// a real child's writes don't split at chosen byte boundaries, yet a PTY
// read boundary can fall anywhere — including inside a title's terminator.
// Regression pin for b8737857, whose introducer-anchored carry was lost in
// the #334 extraction to pty-observability.ts.
describe("foldOscTitle", () => {
  const ESC = "\x1b"
  const BEL = "\x07"

  test("captures a BEL- and an ST-terminated title in one chunk", () => {
    expect(foldOscTitle("", `${ESC}]0;bel${BEL}`)).toEqual({ title: "bel", carry: "" })
    expect(foldOscTitle("", `${ESC}]2;st${ESC}\\`)).toEqual({ title: "st", carry: "" })
  })

  test("last title in the chunk wins; no title closed → null", () => {
    expect(foldOscTitle("", `${ESC}]2;first${BEL}output${ESC}]0;second${BEL}`)).toEqual({
      title: "second",
      carry: "",
    })
    expect(foldOscTitle("", "plain output, no escapes").title).toBeNull()
    expect(foldOscTitle("", `text ${ESC}[0m more`)).toEqual({ title: null, carry: "" })
  })

  test("a title split mid-body across chunks completes on the next chunk", () => {
    const first = foldOscTitle("", `${ESC}]0;my-ti`)
    expect(first).toEqual({ title: null, carry: `${ESC}]0;my-ti` })
    expect(foldOscTitle(first.carry, `tle${BEL}`)).toEqual({ title: "my-title", carry: "" })
  })

  test("a title whose ST terminator splits across chunks is still captured", () => {
    // Pre-fix, lastIndexOf(ESC) kept only the terminator's lone ESC and
    // dropped the whole `ESC ]0;title` introducer — the title was lost.
    const first = foldOscTitle("", `${ESC}]0;split-st${ESC}`)
    expect(first).toEqual({ title: null, carry: `${ESC}]0;split-st${ESC}` })
    expect(foldOscTitle(first.carry, "\\")).toEqual({ title: "split-st", carry: "" })
  })

  test("a title whose introducer splits across chunks is still captured", () => {
    const first = foldOscTitle("", `done${ESC}`)
    expect(first).toEqual({ title: null, carry: ESC })
    expect(foldOscTitle(first.carry, `]2;boot${BEL}`)).toEqual({ title: "boot", carry: "" })
  })
})
