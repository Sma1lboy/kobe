/**
 * Inbound pty-frame dispatch is O(1), not O(open-tabs).
 *
 * Every open terminal tab is a HostedTaskPty on ONE shared pty-host client.
 * The client's `emit()` walks its whole `pty.data` handler Set per inbound
 * frame, so a per-tab `client.on("pty.data")` made every chunk interactive
 * `claude` streams cost N handler-body runs + N `payload.key === taskId`
 * compares (N-1 pure rejections) — on the busiest inbound path. The fix
 * installs ONE keyed dispatcher on the client (`installDispatch`) that does a
 * single `hostedByKey.get(key)?.feedFrame(...)` lookup; a frame reaches
 * exactly its own handle and adding tabs never grows per-frame work for an
 * unrelated key.
 *
 * This test pins that budget deterministically (op-count, not wall-clock):
 * spy `HostedTaskPty.feedFrame` (the sole per-frame dispatch body) and count
 * its invocations when the fake host pushes ONE frame at N=8 open tabs.
 * Before the fix the analogous count would be 8 (every handle's body ran its
 * compare); after it is exactly 1.
 *
 * A REAL `HostedTaskPty` over a REAL `KobeDaemonClient` (protocol-only fake
 * host — no child spawn) exercises the actual dispatcher + `hostedByKey` map
 * + `cleanup()` teardown, so it also guards that detach removes the entry (no
 * leak, no stray chunk to a dead tab).
 */

import { mkdtempSync, rmSync } from "node:fs"
import { type Server, type Socket, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type DaemonFrame, frameToLine } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { HostedTaskPty } from "../../src/tui/panes/terminal/pty-hosted"

/**
 * Protocol-only pty host: answers `hello`/`pty.open` so a real client can
 * attach without spawning a child, swallows write/resize/kill/detach, and
 * exposes `push()` to broadcast one event frame to every attached socket
 * (the exact wire path the real host uses for `pty.data`/`pty.exit`).
 */
class FakePtyHost {
  private readonly server: Server
  private readonly sockets = new Set<Socket>()

  private constructor(server: Server) {
    this.server = server
    server.on("connection", (socket) => {
      this.sockets.add(socket)
      socket.on("error", () => {})
      socket.on("close", () => this.sockets.delete(socket))
      let buf = ""
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8")
        let nl = buf.indexOf("\n")
        while (nl !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (line.trim()) this.onRequest(socket, JSON.parse(line) as DaemonFrame)
          nl = buf.indexOf("\n")
        }
      })
    })
  }

  static start(socketPath: string): Promise<FakePtyHost> {
    return new Promise((resolve, reject) => {
      const server = createServer()
      server.once("error", reject)
      server.listen(socketPath, () => resolve(new FakePtyHost(server)))
    })
  }

  private onRequest(socket: Socket, frame: DaemonFrame): void {
    if (frame.type !== "request") return
    // `pty.open` gets a live, empty-replay attach; everything else (hello,
    // write, resize, kill, detach) just needs *a* reply so the client's
    // pending entry resolves.
    const payload = frame.name === "pty.open" ? { replay: "", alive: true } : {}
    socket.write(frameToLine({ type: "response", id: frame.id, payload }))
  }

  /** Broadcast one event frame to every attached client (the host push path). */
  push(frame: Extract<DaemonFrame, { type: "event" }>): void {
    const line = frameToLine(frame)
    for (const socket of this.sockets) socket.write(line)
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

function dataFrame(key: string): Extract<DaemonFrame, { type: "event" }> {
  return { type: "event", name: "pty.data", payload: { key, data: Buffer.from("x").toString("base64") } }
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout")
    await new Promise((r) => setTimeout(r, 15))
  }
}

const N = 8
const OPTS = { cwd: "/", command: ["/bin/cat"], cols: 40, rows: 10 }

describe("hosted pty inbound dispatch budget", () => {
  // One host + one shared client for the file: the module-level `shared`
  // pty-host connection is a singleton, so tearing the socket down between
  // tests would strand it. Distinct keys per test keep the `hostedByKey` map
  // clean without needing a fresh socket.
  let dir: string
  let host: FakePtyHost

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kobe-pty-dispatch-"))
    process.env.KOBE_PTY_SOCKET_PATH = join(dir, "pty.sock")
    process.env.KOBE_PTY_PID_PATH = join(dir, "pty.pid")
    host = await FakePtyHost.start(process.env.KOBE_PTY_SOCKET_PATH)
  })

  afterAll(async () => {
    await host.close()
    Reflect.deleteProperty(process.env, "KOBE_PTY_SOCKET_PATH")
    Reflect.deleteProperty(process.env, "KOBE_PTY_PID_PATH")
    rmSync(dir, { recursive: true, force: true })
  })

  afterEach(() => vi.restoreAllMocks())

  it("one pushed frame hits exactly one handle's dispatch body, whatever N", async () => {
    // feedFrame is the SOLE per-frame dispatch body — its invocation count is
    // the op budget. Spy it before the handles open so every call is caught.
    const feed = vi.spyOn(HostedTaskPty.prototype, "feedFrame")

    const ptys: HostedTaskPty[] = []
    for (let i = 0; i < N; i++) ptys.push(new HostedTaskPty({ taskId: `t${i}::tab`, ...OPTS }))
    // Wait until every handle has attached (opened its remote), so all N are
    // registered in the shared map and would be walked by an O(N) fan-out.
    await until(() => ptys.every((p) => (p as unknown as { opened: boolean }).opened))
    feed.mockClear()

    // ONE frame for a single key → exactly ONE dispatch-body run, not N.
    host.push(dataFrame("t3::tab"))
    await until(() => feed.mock.calls.length > 0)
    expect(feed).toHaveBeenCalledTimes(1)
    expect(feed.mock.instances[0]).toBe(ptys[3])

    // A frame for an unknown key touches NO handle (dropped by the map miss,
    // same as the old per-handle key-compare rejecting) — and this holds no
    // matter how many tabs are open, i.e. per-frame cost doesn't grow with N.
    feed.mockClear()
    host.push(dataFrame("nobody::tab"))
    await new Promise((r) => setTimeout(r, 80))
    expect(feed).toHaveBeenCalledTimes(0)

    for (const p of ptys) p.detach()
  })

  it("detach removes the map entry — a later frame reaches no handle (no leak)", async () => {
    const feed = vi.spyOn(HostedTaskPty.prototype, "feedFrame")
    const pty = new HostedTaskPty({ taskId: "solo::tab", ...OPTS })
    await until(() => (pty as unknown as { opened: boolean }).opened)

    feed.mockClear()
    pty.detach() // app-teardown / park route — must delete the registration
    host.push(dataFrame("solo::tab"))
    await new Promise((r) => setTimeout(r, 80))
    expect(feed).toHaveBeenCalledTimes(0)
  })
})
