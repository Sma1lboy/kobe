import { mkdtempSync, rmSync } from "node:fs"
import { type Server, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
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
