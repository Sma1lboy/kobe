import { mkdtempSync, rmSync } from "node:fs"
import { type Server, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function silentServer(socketPath: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.on("error", () => {})
      socket.on("data", () => {})
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
    await expect(client.request("daemon.status")).rejects.toThrow("daemon client disposed")
  })

  it("forceDisconnect keeps the client revivable: a fresh connect + request works", async () => {
    const client = new KobeDaemonClient(socketPath)
    await client.connect()
    const stale = client.request("daemon.status")
    await settle()
    client.forceDisconnect()
    await expect(stale).rejects.toThrow("daemon connection closed")
    await client.connect()
    const fresh = client.request("daemon.status")
    await settle()
    client.forceDisconnect()
    await expect(fresh).rejects.toThrow("daemon connection closed")
    client.close()
  })
})
