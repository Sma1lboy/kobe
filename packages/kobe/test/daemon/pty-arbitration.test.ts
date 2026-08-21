/**
 * Multi-client arbitration (`pty-arbitration.ts` + `PtyHost`): what one
 * hosted session does when TWO connections are attached to it.
 *
 * The pinned contract (issue #259):
 *   - both attaches land on the SAME child (no re-spawn, no steal) and both
 *     get the ring replay;
 *   - output fans out to every attached client, so B's keystroke echoes to A;
 *   - input is tmux semantics: either client may write, and one `pty.write`
 *     payload crosses to the child as ONE contiguous chunk;
 *   - resize is last-writer-wins, an unchanged resize is a no-op, and a real
 *     change is announced to the OTHER clients as a `pty.resized` event;
 *   - one client detaching (or dropping its socket) leaves the session live
 *     for the survivor;
 *   - `pty.kill` from one client tears the session down for both.
 *
 * Two harnesses, matching the existing suite: a unit `PtyHost` over a fake
 * driver (`pty-host-freeze.test.ts`) for the rules themselves, and a real
 * socket server with two `KobeDaemonClient`s (`pty-server-restart.test.ts`)
 * for the over-the-wire proof that per-connection identity is what the host
 * arbitrates on.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import type { DaemonFrame, PtyOpenResult } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { PtyChild, PtyDriver, PtyExit } from "@sma1lboy/kobe-daemon/daemon/pty-driver"
import { PtyHost } from "@sma1lboy/kobe-daemon/daemon/pty-host"
import { type PtyHostServer, startPtyHostServer } from "@sma1lboy/kobe-daemon/daemon/pty-server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

class FakeChild {
  static nextPid = 3000
  readonly pid = FakeChild.nextPid++
  readonly written: string[] = []
  readonly resizes: Array<{ cols: number; rows: number }> = []
  private settle!: (exit: PtyExit) => void
  readonly exited = new Promise<PtyExit>((resolve) => {
    this.settle = resolve
  })
  constructor(private readonly onData: (data: string | Uint8Array) => void) {}
  write(data: string): void {
    this.written.push(data)
    this.onData(data) // echo, like /bin/cat
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows })
  }
  close(): void {}
  kill(signal: NodeJS.Signals): void {
    this.settle({ code: null, signal })
  }
}

function fakeDriverWith(children: FakeChild[]): PtyDriver {
  return (request) => {
    const child = new FakeChild(request.onData)
    children.push(child)
    return child as unknown as PtyChild
  }
}

const SPEC = { cwd: "/wt/t1", command: ["/bin/cat"], cols: 80, rows: 24 }
const KEY = "t1::tab-1"

type Frame = Extract<DaemonFrame, { type: "event" }>

function text(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8")
}

function dataText(frames: Frame[]): string {
  return frames
    .filter((f) => f.name === "pty.data")
    .map((f) => text((f.payload as { data: string }).data))
    .join("")
}

describe("PtyHost multi-client arbitration", () => {
  function two() {
    const children: FakeChild[] = []
    const host = new PtyHost({ driver: fakeDriverWith(children) })
    const a: Frame[] = []
    const b: Frame[] = []
    const tokenA = { name: "a" }
    const tokenB = { name: "b" }
    const openA = host.open(KEY, SPEC, tokenA, (f) => a.push(f as Frame))
    const openB = host.open(KEY, SPEC, tokenB, (f) => b.push(f as Frame))
    return { host, children, a, b, tokenA, tokenB, openA, openB }
  }

  it("a second open ATTACHES to the running child — no re-spawn, no steal, ring replayed", () => {
    const children: FakeChild[] = []
    const host = new PtyHost({ driver: fakeDriverWith(children) })
    const openA = host.open(KEY, SPEC, {}, () => {})
    children[0].write("scene\n")

    const openB = host.open(KEY, SPEC, {}, () => {})
    expect(children).toHaveLength(1) // the child is shared, not duplicated
    expect(openB).toMatchObject({ created: false, respawned: false, alive: true, pid: openA.pid })
    expect(text(openB.replay)).toContain("scene")
    // A's stream is untouched by B's arrival: same session, same offsets.
    expect(openB.offset).toBe(children[0].written.join("").length)
  })

  it("output fans out to BOTH clients, so B's keystroke echoes to A", () => {
    const h = two()
    h.host.write(KEY, "from-b\r")
    expect(dataText(h.a)).toBe("from-b\r")
    expect(dataText(h.b)).toBe("from-b\r")
  })

  it("either client may write (tmux semantics) and one payload stays contiguous", () => {
    const h = two()
    h.host.write(KEY, "aaaa")
    h.host.write(KEY, "bbbb")
    h.host.write(KEY, "cccc")
    // No exclusive-writer lock: every payload reached the child, in arrival
    // order, each as ONE undivided write.
    expect(h.children[0].written).toEqual(["aaaa", "bbbb", "cccc"])
    expect(dataText(h.a)).toBe("aaaabbbbcccc")
    expect(dataText(h.b)).toBe("aaaabbbbcccc")
  })

  it("resize is last-writer-wins and is announced to the OTHER client only", () => {
    const h = two()
    h.host.resize(KEY, 120, 40, h.tokenA)
    h.host.resize(KEY, 100, 30, h.tokenB)

    // The child follows the newest request, whoever sent it.
    expect(h.children[0].resizes).toEqual([
      { cols: 120, rows: 40 },
      { cols: 100, rows: 30 },
    ])
    // Each client hears about the other's resize, never its own echo.
    expect(h.a.filter((f) => f.name === "pty.resized").map((f) => f.payload)).toEqual([
      { key: KEY, cols: 100, rows: 30 },
    ])
    expect(h.b.filter((f) => f.name === "pty.resized").map((f) => f.payload)).toEqual([
      { key: KEY, cols: 120, rows: 40 },
    ])
  })

  it("an unchanged resize is a no-op: no SIGWINCH, no broadcast", () => {
    const h = two()
    h.host.resize(KEY, 120, 40, h.tokenA)
    h.host.resize(KEY, 120, 40, h.tokenB)
    h.host.resize(KEY, 120, 40, h.tokenA)
    expect(h.children[0].resizes).toEqual([{ cols: 120, rows: 40 }])
    expect(h.b.filter((f) => f.name === "pty.resized")).toHaveLength(1)
    expect(h.a.filter((f) => f.name === "pty.resized")).toHaveLength(0)
  })

  it("a same-size reattach never resizes; a differently-sized one does, and tells the sitting client", () => {
    const h = two()
    h.host.detach(KEY, h.tokenB)
    h.host.open(KEY, SPEC, h.tokenB, (f) => h.b.push(f as Frame))
    expect(h.children[0].resizes).toEqual([])

    h.host.detach(KEY, h.tokenB)
    h.host.open(KEY, { ...SPEC, cols: 132, rows: 43 }, h.tokenB, (f) => h.b.push(f as Frame))
    expect(h.children[0].resizes).toEqual([{ cols: 132, rows: 43 }])
    expect(h.a.filter((f) => f.name === "pty.resized").map((f) => f.payload)).toEqual([
      { key: KEY, cols: 132, rows: 43 },
    ])
  })

  it("one client detaching leaves the session live and streaming for the survivor", () => {
    const h = two()
    h.host.detach(KEY, h.tokenB, true, 4096)
    h.host.write(KEY, "after-detach")

    expect(h.host.liveCount()).toBe(1)
    expect(dataText(h.a)).toBe("after-detach")
    expect(dataText(h.b)).toBe("")
    // A park flag describes the session's visibility — a still-attached
    // client means the session is NOT parked.
    expect(h.host.list()[0]).toMatchObject({ key: KEY, alive: true })
  })

  it("a transient headless open does not wipe another client's park bookkeeping", () => {
    const children: FakeChild[] = []
    const host = new PtyHost({ driver: fakeDriverWith(children) })
    const tui = { name: "tui" }
    host.open(KEY, SPEC, tui, () => {})
    children[0].write("screen\n")
    host.detach(KEY, tui, true, 4096)
    expect(host.stats()).toMatchObject({ parkedSessions: 1, parkedScreenBytes: 4096 })

    // `rove api send`'s delivery attach: size-less, no sinceOffset, gone a
    // moment later. It must not clear the parked TUI's accounting.
    const headless = { name: "headless" }
    host.open(KEY, { cwd: "/wt/t1" }, headless, () => {})
    expect(host.stats()).toMatchObject({ parkedSessions: 1, parkedScreenBytes: 4096 })

    // The parking client coming back for its delta DOES end the park.
    host.open(KEY, SPEC, tui, () => {}, 0, children[0].pid)
    expect(host.stats()).toMatchObject({ parkedSessions: 0, parkedScreenBytes: 0 })
  })

  it("kill from one client tears the session down for both", async () => {
    const h = two()
    await h.host.kill(KEY)
    expect(h.host.liveCount()).toBe(0)
    expect(h.host.list()).toEqual([])
    for (const frames of [h.a, h.b]) {
      expect(frames.filter((f) => f.name === "pty.exit").map((f) => (f.payload as { key: string }).key)).toEqual([KEY])
    }
  })
})

/* ------------------------------------------------------------------ *
 * Over the wire: two real socket connections to one pty-host process.
 * ------------------------------------------------------------------ */

let dir: string
let socketPath: string
let pidPath: string
let savedHome: string | undefined
const servers: PtyHostServer[] = []
const clients: KobeDaemonClient[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kobe-pty-arb-"))
  socketPath = join(dir, "pty.sock")
  pidPath = join(dir, "pty.pid")
  savedHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = dir
})

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  for (const server of servers.splice(0)) await server.close().catch(() => {})
  if (savedHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = savedHome
  rmSync(dir, { recursive: true, force: true })
})

async function bootHost(children: FakeChild[]): Promise<PtyHostServer> {
  const server = await startPtyHostServer({
    socketPath,
    pidPath,
    freezeDir: join(dir, "pty-sessions"),
    driver: fakeDriverWith(children),
    idleExitMs: 60_000,
  })
  servers.push(server)
  return server
}

async function connect(collected: Frame[]): Promise<KobeDaemonClient> {
  const client = new KobeDaemonClient(socketPath)
  await client.connect()
  client.on("*", (frame) => collected.push(frame))
  clients.push(client)
  return client
}

/** Round-trip a cheap RPC so every frame the host already queued has landed. */
async function settle(client: KobeDaemonClient): Promise<void> {
  await client.request("pty.list", {})
}

describe("pty-host server: two connections on one session key", () => {
  it("both see the same stream, both may type, and the last resize wins", async () => {
    const children: FakeChild[] = []
    await bootHost(children)
    const aFrames: Frame[] = []
    const bFrames: Frame[] = []
    const a = await connect(aFrames)
    const b = await connect(bFrames)

    const openedA = await a.request<PtyOpenResult>("pty.open", { key: KEY, cwd: "/wt/t1", command: ["/bin/cat"] })
    expect(openedA.created).toBe(true)
    const openedB = await b.request<PtyOpenResult>("pty.open", { key: KEY, cwd: "/wt/t1", command: ["/bin/cat"] })
    expect(openedB).toMatchObject({ created: false, alive: true, pid: openedA.pid })
    expect(children).toHaveLength(1)

    await a.request("pty.write", { key: KEY, data: "typed-by-a\n" })
    await b.request("pty.write", { key: KEY, data: "typed-by-b\n" })
    await settle(a)
    await settle(b)

    // Both connections see BOTH clients' input echoed by the shared child.
    expect(dataText(aFrames)).toBe("typed-by-a\ntyped-by-b\n")
    expect(dataText(bFrames)).toBe("typed-by-a\ntyped-by-b\n")
    expect(children[0].written).toEqual(["typed-by-a\n", "typed-by-b\n"])

    await a.request("pty.resize", { key: KEY, cols: 200, rows: 50 })
    await b.request("pty.resize", { key: KEY, cols: 90, rows: 28 })
    await settle(a)
    await settle(b)

    expect(children[0].resizes).toEqual([
      { cols: 200, rows: 50 },
      { cols: 90, rows: 28 },
    ])
    expect(aFrames.filter((f) => f.name === "pty.resized").map((f) => f.payload)).toEqual([
      { key: KEY, cols: 90, rows: 28 },
    ])
    expect(bFrames.filter((f) => f.name === "pty.resized").map((f) => f.payload)).toEqual([
      { key: KEY, cols: 200, rows: 50 },
    ])
  })

  it("a dropped socket detaches only that client; the survivor keeps streaming", async () => {
    const children: FakeChild[] = []
    await bootHost(children)
    const aFrames: Frame[] = []
    const bFrames: Frame[] = []
    const a = await connect(aFrames)
    const b = await connect(bFrames)
    await a.request("pty.open", { key: KEY, cwd: "/wt/t1", command: ["/bin/cat"] })
    await b.request("pty.open", { key: KEY, cwd: "/wt/t1", command: ["/bin/cat"] })

    b.close()
    // Let the host's `close` handler run detachClient before the next write.
    await new Promise((r) => setTimeout(r, 50))
    await settle(a)

    await a.request("pty.write", { key: KEY, data: "still-here\n" })
    await settle(a)
    const listed = await a.request<{ sessions: Array<{ key: string; alive: boolean }> }>("pty.list", {})
    expect(listed.sessions).toMatchObject([{ key: KEY, alive: true }])
    expect(dataText(aFrames)).toContain("still-here")
    expect(dataText(bFrames)).not.toContain("still-here")
  })

  it("an explicit pty.detach by one connection does not park or end the shared session", async () => {
    const children: FakeChild[] = []
    await bootHost(children)
    const aFrames: Frame[] = []
    const bFrames: Frame[] = []
    const a = await connect(aFrames)
    const b = await connect(bFrames)
    await a.request("pty.open", { key: KEY, cwd: "/wt/t1", command: ["/bin/cat"] })
    await b.request("pty.open", { key: KEY, cwd: "/wt/t1", command: ["/bin/cat"] })

    await b.request("pty.detach", { key: KEY, parked: true, parkedScreenBytes: 4096 })
    await a.request("pty.write", { key: KEY, data: "survivor\n" })
    await settle(a)
    await settle(b)

    const listed = await a.request<{ sessions: Array<{ key: string; alive: boolean }> }>("pty.list", {})
    expect(listed.sessions).toMatchObject([{ key: KEY, alive: true }])
    expect(dataText(aFrames)).toContain("survivor")
    expect(dataText(bFrames)).not.toContain("survivor")
  })

  it("pty.kill from one connection ends the session for both", async () => {
    const children: FakeChild[] = []
    await bootHost(children)
    const aFrames: Frame[] = []
    const bFrames: Frame[] = []
    const a = await connect(aFrames)
    const b = await connect(bFrames)
    await a.request("pty.open", { key: KEY, cwd: "/wt/t1", command: ["/bin/cat"] })
    await b.request("pty.open", { key: KEY, cwd: "/wt/t1", command: ["/bin/cat"] })

    await b.request("pty.kill", { key: KEY })
    for (let i = 0; i < 50 && aFrames.every((f) => f.name !== "pty.exit"); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }

    expect(aFrames.some((f) => f.name === "pty.exit")).toBe(true)
    expect(bFrames.some((f) => f.name === "pty.exit")).toBe(true)
    const listed = await a.request<{ sessions: unknown[] }>("pty.list", {})
    expect(listed.sessions).toEqual([])
  })
})
