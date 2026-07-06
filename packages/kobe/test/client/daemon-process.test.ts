import { unlinkSync } from "node:fs"
import { type Server, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testDaemonResponds } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { afterEach, describe, expect, it } from "vitest"

const SOCK_DIR = process.platform === "darwin" ? "/tmp" : tmpdir()
const servers: Server[] = []
const openSockets = new Set<import("node:net").Socket>()
type EventedServer = Server & { once(event: "error", listener: (err: Error) => void): void }

function listen(handler?: (sock: import("node:net").Socket) => void): Promise<string> {
  const path = join(SOCK_DIR, `kobe-dpr-${process.pid}-${servers.length}.sock`)
  try {
    unlinkSync(path)
  } catch {}
  const server = createServer((sock) => {
    openSockets.add(sock)
    sock.on("close", () => openSockets.delete(sock))
    handler?.(sock)
  })
  servers.push(server)
  return new Promise((resolve, reject) => {
    ;(server as EventedServer).once("error", reject)
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
    const path = await listen(() => {})
    expect(await testDaemonResponds(path, 300)).toBe(false)
  })

  it("is false when no daemon is listening", async () => {
    expect(await testDaemonResponds(join(SOCK_DIR, `kobe-dpr-absent-${process.pid}.sock`), 300)).toBe(false)
  })
})
