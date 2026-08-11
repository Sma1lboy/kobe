import type { PtyChild, PtyExit, PtySpawnRequest } from "@sma1lboy/kobe-daemon/daemon/pty-driver"
import { PtyHost } from "@sma1lboy/kobe-daemon/daemon/pty-host"
import type { PtySessionEndInfo } from "@sma1lboy/kobe-daemon/daemon/pty-observability"
import { describe, expect, test } from "vitest"

/** Records what PtyHost asks a driver for, and lets a test drive the child. */
function recordingDriver() {
  const requests: PtySpawnRequest[] = []
  const calls: string[] = []
  let settleExit: (exit?: PtyExit) => void = () => {}
  const child: PtyChild = {
    pid: 4242,
    exited: new Promise<PtyExit>((resolve) => {
      settleExit = (exit) => resolve(exit ?? { code: 0, signal: null })
    }),
    write: (data) => calls.push(`write:${data}`),
    resize: (cols, rows) => calls.push(`resize:${cols}x${rows}`),
    close: () => calls.push("close"),
    kill: (signal) => calls.push(`kill:${signal}`),
  }
  const driver = (request: PtySpawnRequest): PtyChild => {
    requests.push(request)
    return child
  }
  return { driver, requests, calls, settleExit }
}

describe("PtyHost driver seam", () => {
  test("spawns through the injected driver and forwards io to its child", () => {
    const rec = recordingDriver()
    const host = new PtyHost({ driver: rec.driver })
    const client = {}

    const opened = host.open("t::tab-1", { cwd: "/wt", command: ["bash", "-il"], cols: 90, rows: 30 }, client, () => {})

    expect(opened.alive).toBe(true)
    expect(opened.pid).toBe(4242)
    expect(rec.requests).toHaveLength(1)
    expect(rec.requests[0]?.argv).toEqual(["bash", "-il"])
    expect(rec.requests[0]?.cwd).toBe("/wt")
    expect(rec.requests[0]?.cols).toBe(90)
    // The child sees a terminal identity, not the outer emulator's.
    expect(rec.requests[0]?.env.TERM).toBe("xterm-256color")
    expect(rec.requests[0]?.env.KOBE_TERMINAL_PTY).toBe("1")

    host.write("t::tab-1", "ls\r")
    host.resize("t::tab-1", 100, 40)
    expect(rec.calls).toEqual(["write:ls\r", "resize:100x40"])
  })

  test("fans driver output out to attached sinks as pty.data", () => {
    const rec = recordingDriver()
    const host = new PtyHost({ driver: rec.driver })
    const frames: unknown[] = []
    host.open("t::tab-1", { cwd: "/wt", command: ["bash"], cols: 80, rows: 24 }, {}, (frame) => frames.push(frame))

    rec.requests[0]?.onData("hello")

    expect(frames).toContainEqual({
      type: "event",
      name: "pty.data",
      payload: { key: "t::tab-1", data: Buffer.from("hello").toString("base64") },
    })
  })

  test("a child that exits on its own releases the pty handle and tells every sink", async () => {
    const rec = recordingDriver()
    const host = new PtyHost({ driver: rec.driver })
    const frames: Array<{ name?: string; payload?: unknown }> = []
    host.open("t::tab-1", { cwd: "/wt", command: ["bash"], cols: 80, rows: 24 }, {}, (frame) => frames.push(frame))
    expect(host.liveCount()).toBe(1)

    rec.settleExit()
    await Promise.resolve()
    await Promise.resolve()

    expect(host.liveCount()).toBe(0)
    // close() is the driver's "release the handle" hook — skipping it leaks a
    // ConPTY pseudoconsole per session on Windows.
    expect(rec.calls).toContain("close")
    // The exit frame carries the death cause (issue #9) — key/pid plus
    // code/signal/at so an attached client can render "engine died: 1".
    const exit = frames.find((f) => f.name === "pty.exit")
    expect(exit?.payload).toMatchObject({ key: "t::tab-1", pid: 4242, code: 0, signal: null })
    expect((exit?.payload as { at?: string }).at).toBeTruthy()
  })

  test("records the death cause: exit code/signal in list(), the log line, and the onSessionExit record", async () => {
    const rec = recordingDriver()
    const logs: string[] = []
    const deaths: PtySessionEndInfo[] = []
    const host = new PtyHost({
      driver: rec.driver,
      log: (_event, message) => logs.push(message),
      onSessionExit: (info) => deaths.push(info),
    })
    host.open("t::tab-1", { cwd: "/wt", command: ["claude"], cols: 80, rows: 24 }, {}, () => {})
    rec.requests[0]?.onData("boom: config missing\r\n")

    rec.settleExit({ code: 1, signal: null })
    await Promise.resolve()
    await Promise.resolve()

    expect(host.list()[0]?.exit).toMatchObject({ code: 1, signal: null })
    expect(logs.some((line) => line.includes("session t::tab-1 exited (code 1)"))).toBe(true)
    expect(deaths).toHaveLength(1)
    expect(deaths[0]).toMatchObject({ key: "t::tab-1", pid: 4242, exit: { code: 1, signal: null } })
    expect(deaths[0]?.tail).toContain("boom: config missing")
    // peek keeps answering after death — scrollback plus the recorded cause.
    expect(host.peek("t::tab-1").exit).toMatchObject({ code: 1, signal: null })
  })

  test("a signal death logs the signal, and a throwing onSessionExit never blocks teardown", async () => {
    const rec = recordingDriver()
    const logs: string[] = []
    const host = new PtyHost({
      driver: rec.driver,
      log: (_event, message) => logs.push(message),
      onSessionExit: () => {
        throw new Error("disk full")
      },
    })
    host.open("t::tab-1", { cwd: "/wt", command: ["claude"], cols: 80, rows: 24 }, {}, () => {})

    rec.settleExit({ code: null, signal: "SIGKILL" })
    await Promise.resolve()
    await Promise.resolve()

    // The record hook threw, but the session still tore down cleanly.
    expect(host.liveCount()).toBe(0)
    expect(logs.some((line) => line.includes("exited (signal SIGKILL)"))).toBe(true)
  })

  test("escalates to SIGKILL and still finishes when the child never reports exiting", async () => {
    // The node-pty driver's `exited` settles only when ConPTY delivers onExit.
    // An unbounded await here used to hang killAll(), and with it the host's
    // shutdown and `kobe reset`.
    const rec = recordingDriver()
    const host = new PtyHost({ driver: rec.driver })
    host.open("t::tab-1", { cwd: "/wt", command: ["bash"], cols: 80, rows: 24 }, {}, () => {})

    await host.kill("t::tab-1")

    // SIGTERM, then SIGKILL when the grace lapses — and the handle is still
    // released, so a forced kill leaks no ConPTY pseudoconsole.
    expect(rec.calls).toEqual(["kill:SIGTERM", "kill:SIGKILL", "close"])
    expect(host.liveCount()).toBe(0)
  }, 5000)

  test("a driver that throws leaves a dead session instead of taking the host down", () => {
    const host = new PtyHost({
      driver: () => {
        throw new Error("terminal option is not supported on this platform")
      },
    })
    const opened = host.open("t::tab-1", { cwd: "/wt", command: ["bash"], cols: 80, rows: 24 }, {}, () => {})
    expect(opened.alive).toBe(false)
    expect(host.liveCount()).toBe(0)
  })
})
