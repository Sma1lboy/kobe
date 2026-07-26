import type { PtyChild, PtySpawnRequest } from "@sma1lboy/kobe-daemon/daemon/pty-driver"
import { PtyHost } from "@sma1lboy/kobe-daemon/daemon/pty-host"
import { describe, expect, test } from "vitest"

/** Records what PtyHost asks a driver for, and lets a test drive the child. */
function recordingDriver() {
  const requests: PtySpawnRequest[] = []
  const calls: string[] = []
  let settleExit: () => void = () => {}
  const child: PtyChild = {
    pid: 4242,
    exited: new Promise<void>((resolve) => {
      settleExit = resolve
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
    expect(frames).toContainEqual({ type: "event", name: "pty.exit", payload: { key: "t::tab-1", pid: 4242 } })
  })

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
