import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sweepPtyHostSessions } from "@sma1lboy/kobe-daemon/client/pty-process"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * Regression pin — incident 2026-07-07/08: `sweepPtyHostSessions` resolved
 * the pty-host socket from ambient env instead of the calling daemon's
 * homeDir, so every temp-home test daemon (test:socket suite) swept the
 * REAL user pty-host with its fake (empty) task list and killed every live
 * engine session on the machine, on every `bun run test`.
 *
 * The pin: given an explicit homeDir, the sweep's connection MUST land on
 * `<homeDir>/.kobe/pty.sock` — observed via a raw listener planted there.
 */
describe("sweepPtyHostSessions homeDir isolation", () => {
  let dir: string
  let server: net.Server | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kobe-sweep-"))
    mkdirSync(join(dir, ".kobe"), { recursive: true })
  })

  afterEach(async () => {
    if (server) await new Promise((resolve) => server?.close(resolve))
    server = null
    rmSync(dir, { recursive: true, force: true })
  })

  it("connects to the pty socket under the given homeDir, not the ambient default", async () => {
    const socketPath = join(dir, ".kobe", "pty.sock")
    let connections = 0
    server = net.createServer((socket) => {
      connections++
      // Not a real pty-host: drop the connection; the sweep is documented
      // fire-and-forget and must swallow the failure.
      socket.destroy()
    })
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve))

    await sweepPtyHostSessions([], dir)

    expect(connections).toBe(1)
  })
})
