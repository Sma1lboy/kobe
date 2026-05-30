import { unlinkSync } from "node:fs"
import { type Server, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { testDaemonResponds } from "../../src/client/daemon-process.ts"

// Short paths: macOS caps unix-socket paths at ~104 chars, and tmpdir() can
// be long, so anchor under /tmp where available.
const SOCK_DIR = process.platform === "darwin" ? "/tmp" : tmpdir()
const servers: Server[] = []
const openSockets = new Set<import("node:net").Socket>()

function listen(handler?: (sock: import("node:net").Socket) => void): Promise<string> {
  const path = join(SOCK_DIR, `kobe-dpr-${process.pid}-${servers.length}.sock`)
  try {
    unlinkSync(path)
  } catch {
    /* no stale socket — fine */
  }
  // Track server-side connections so afterEach can destroy them — a wedged
  // server never closes its socket, so `server.close()` would otherwise hang.
  const server = createServer((sock) => {
    openSockets.add(sock)
    sock.on("close", () => openSockets.delete(sock))
    handler?.(sock)
  })
  servers.push(server)
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, () => resolve(path))
  })
}

afterEach(async () => {
  for (const sock of openSockets) sock.destroy()
  openSockets.clear()
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

describe("testDaemonResponds", () => {
  it("is true when the daemon answers hello", async () => {
    const path = await listen((sock) => {
      sock.on("data", (chunk) => {
        for (const line of chunk.toString().split("\n").filter(Boolean)) {
          const frame = JSON.parse(line) as { id: string; name: string }
          if (frame.name === "hello") {
            sock.write(`${JSON.stringify({ type: "response", id: frame.id, payload: { protocolVersion: 2 } })}\n`)
          }
        }
      })
    })
    expect(await testDaemonResponds(path, 1000)).toBe(true)
  })

  it("is false for a wedged daemon — accepts the socket but never replies", async () => {
    const path = await listen(() => {
      /* accept the connection and ignore it: the wedge we must detect */
    })
    expect(await testDaemonResponds(path, 300)).toBe(false)
  })

  it("is false when no daemon is listening", async () => {
    expect(await testDaemonResponds(join(SOCK_DIR, `kobe-dpr-absent-${process.pid}.sock`), 300)).toBe(false)
  })
})
