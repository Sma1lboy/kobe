import { mkdtempSync, rmSync } from "node:fs"
import { type Server, type Socket, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KobeDaemonClient, RpcTimeoutError } from "@sma1lboy/kobe-daemon/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * `request()` awaits `connect()` before parking the entry in `pending`, so
 * after firing a request we must yield the event loop once — otherwise a
 * synchronous teardown lands BEFORE the entry exists and the rejection comes
 * from the "connection is not open" guard, not the pending sweep under test.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A unix-socket server that ACCEPTS connections but never answers a frame. */
function silentServer(socketPath: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.on("error", () => {})
      socket.on("data", () => {
        /* swallow — never respond, so requests stay in-flight */
      })
    })
    server.once("error", reject)
    server.listen(socketPath, () => resolve(server))
  })
}

/** Server that hands back its accepted socket so a test can push raw frames. */
function pushServer(socketPath: string): Promise<{ server: Server; nextSocket: () => Promise<Socket> }> {
  let resolveSock: ((s: Socket) => void) | null = null
  const socketPromise = new Promise<Socket>((r) => {
    resolveSock = r
  })
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.on("error", () => {})
      resolveSock?.(socket)
    })
    server.once("error", reject)
    server.listen(socketPath, () => resolve({ server, nextSocket: () => socketPromise }))
  })
}

describe("KobeDaemonClient pending-request cleanup", () => {
  let dir: string
  let socketPath: string
  let server: Server | null

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kobe-clientpend-"))
    socketPath = join(dir, "daemon.sock")
    server = await silentServer(socketPath)
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
    })
    server = null
    rmSync(dir, { recursive: true, force: true })
  })

  it("forceDisconnect rejects every in-flight request instead of retaining it", async () => {
    const client = new KobeDaemonClient(socketPath)
    await client.connect()
    const first = client.request("daemon.status")
    const second = client.request("task.list")
    await settle()
    client.forceDisconnect()
    await expect(first).rejects.toThrow("daemon connection closed")
    await expect(second).rejects.toThrow("daemon connection closed")
    client.close()
  })

  it("close rejects in-flight requests on a disposed client", async () => {
    const client = new KobeDaemonClient(socketPath)
    await client.connect()
    const inflight = client.request("daemon.status")
    await settle()
    client.close()
    await expect(inflight).rejects.toThrow("daemon connection closed")
    // Disposed stays disposed — no silent revival path that could re-park entries.
    await expect(client.request("daemon.status")).rejects.toThrow("daemon client disposed")
  })

  it("forceDisconnect keeps the client revivable: a fresh connect + request works", async () => {
    const client = new KobeDaemonClient(socketPath)
    await client.connect()
    const stale = client.request("daemon.status")
    await settle()
    client.forceDisconnect()
    await expect(stale).rejects.toThrow("daemon connection closed")
    // Reconnect must start from a clean pending map (no stale rejections).
    await client.connect()
    const fresh = client.request("daemon.status")
    await settle()
    // Still a silent server — tear down again and confirm only the NEW
    // request is swept, proving the map was empty between connections.
    client.forceDisconnect()
    await expect(fresh).rejects.toThrow("daemon connection closed")
    client.close()
  })
})

/**
 * A WEDGED daemon (process alive, socket accepting, no response frame) must
 * NOT hang a request forever — the per-request deadline converts it into the
 * ordinary disconnected→reconnect lifecycle so the UI sees the failure.
 */
describe("KobeDaemonClient wedged-daemon deadline", () => {
  let dir: string
  let socketPath: string
  let server: Server | null
  const prev = process.env.KOBE_RPC_TIMEOUT_MS

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "kobe-clientwedge-"))
    socketPath = join(dir, "daemon.sock")
    server = await silentServer(socketPath) // accepts, never answers → wedged
    process.env.KOBE_RPC_TIMEOUT_MS = "40" // short deadline for the test
  })

  afterEach(async () => {
    // biome-ignore lint/performance/noDelete: env must fully unset when it was unset pre-test (assigning undefined leaves the string "undefined").
    if (prev === undefined) delete process.env.KOBE_RPC_TIMEOUT_MS
    else process.env.KOBE_RPC_TIMEOUT_MS = prev
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
    })
    server = null
    rmSync(dir, { recursive: true, force: true })
  })

  it("rejects with RpcTimeoutError and emits close so the host can reconnect", async () => {
    const client = new KobeDaemonClient(socketPath)
    await client.connect()
    let closed = false
    client.onLifecycle("close", () => {
      closed = true
    })
    // The deadline must fire the lifecycle "close" itself: forceDisconnect
    // nulls the socket before destroy(), so onSocketClose's stale guard would
    // otherwise swallow it and connectionState would stay stuck "online".
    await expect(client.request("task.status")).rejects.toBeInstanceOf(RpcTimeoutError)
    expect(closed).toBe(true)
    client.close()
  })

  it("exempts minute-scale RPCs (worktree.list) from the deadline", async () => {
    const client = new KobeDaemonClient(socketPath)
    await client.connect()
    const exempt = client.request("worktree.list")
    // Past the (short) deadline it must still be pending, not rejected.
    const raced = await Promise.race([
      exempt.then(() => "settled").catch(() => "rejected"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 120)),
    ])
    expect(raced).toBe("pending")
    client.close() // sweeps it now
    await expect(exempt).rejects.toThrow("daemon connection closed")
  })
})

/**
 * Event dispatch must survive a throwing subscriber: one bad handler must not
 * skip the rest of the same frame, and the throw must not escape the socket
 * 'data' callback (which would go deaf on all further frames).
 */
describe("KobeDaemonClient emit isolates a throwing handler", () => {
  let dir: string
  let socketPath: string
  let server: Server | null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kobe-clientemit-"))
    socketPath = join(dir, "daemon.sock")
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
    })
    server = null
    rmSync(dir, { recursive: true, force: true })
  })

  it("a throwing channel handler doesn't skip the other handlers or the '*' handler", async () => {
    const { server: srv, nextSocket } = await pushServer(socketPath)
    server = srv
    const client = new KobeDaemonClient(socketPath)
    await client.connect()
    const sock = await nextSocket()

    let good = 0
    let star = 0
    client.on("active-task", () => {
      throw new Error("bad listener")
    })
    client.on("active-task", () => {
      good++
    })
    client.on("*", () => {
      star++
    })

    const frame = JSON.stringify({ type: "event", name: "active-task", payload: { taskId: "t1" } })
    sock.write(`${frame}\n${frame}\n`) // two frames back to back
    await new Promise((r) => setTimeout(r, 30))

    expect(good).toBe(2) // both frames reached the good handler despite the throw
    expect(star).toBe(2) // '*' not skipped by the earlier throw
    client.close()
  })
})
