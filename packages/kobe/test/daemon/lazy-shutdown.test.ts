import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { KobeDaemonClient } from "../../src/client/index.ts"
import { type DaemonServer, startDaemonServer } from "../../src/daemon/server.ts"
import type { Orchestrator } from "../../src/orchestrator/core.ts"

/**
 * Refcounted lazy shutdown: the daemon's lifetime is bound to the number of
 * attached GUIs (subscribed TUIs). The last subscriber leaving arms a short
 * grace, then the daemon self-stops. Transient CLI pokes (hello-only, never
 * subscribed) must NOT count, so they never trip shutdown. These exercise the
 * real socket path end to end under the `test:socket` pool.
 */

const GRACE_MS = 80

/** Minimal orchestrator: the refcount path only touches subscribeTasks + listTasks. */
function fakeOrchestrator(): Orchestrator {
  return {
    subscribeTasks: (listener: (snapshot: unknown[]) => void) => {
      listener([])
      return () => {}
    },
    listTasks: () => [],
  } as unknown as Orchestrator
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return predicate()
}

describe("daemon refcounted lazy shutdown", () => {
  let dir: string
  let socketPath: string
  let pidPath: string
  let server: DaemonServer | null
  let prevGrace: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kobe-lazy-"))
    socketPath = join(dir, "daemon.sock")
    pidPath = join(dir, "daemon.pid")
    prevGrace = process.env.KOBE_DAEMON_IDLE_GRACE_MS
    process.env.KOBE_DAEMON_IDLE_GRACE_MS = String(GRACE_MS)
    server = null
  })

  afterEach(async () => {
    if (prevGrace === undefined) Reflect.deleteProperty(process.env, "KOBE_DAEMON_IDLE_GRACE_MS")
    else process.env.KOBE_DAEMON_IDLE_GRACE_MS = prevGrace
    await server?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  it("self-stops a grace period after the last subscriber disconnects", async () => {
    server = await startDaemonServer(fakeOrchestrator(), {
      socketPath,
      pidPath,
      updatePollMs: 0,
    })
    const client = new KobeDaemonClient(socketPath)
    await client.request("hello")
    await client.subscribe()
    // A subscribed GUI is attached → daemon must NOT be tearing down yet.
    expect(existsSync(socketPath)).toBe(true)

    client.close()
    // Last GUI gone → grace timer fires → close() unlinks the socket + pidfile.
    expect(await until(() => !existsSync(socketPath), GRACE_MS + 500)).toBe(true)
    expect(existsSync(pidPath)).toBe(false)
  })

  it("stays up for a transient, never-subscribed connection", async () => {
    server = await startDaemonServer(fakeOrchestrator(), {
      socketPath,
      pidPath,
      updatePollMs: 0,
    })
    const poke = new KobeDaemonClient(socketPath)
    await poke.request("hello")
    await poke.request("daemon.status")
    poke.close()

    // Wait past the grace window; a non-GUI socket never armed the timer.
    await new Promise((r) => setTimeout(r, GRACE_MS + 150))
    expect(existsSync(socketPath)).toBe(true)
  })

  it("only stops once the LAST of several subscribers leaves", async () => {
    server = await startDaemonServer(fakeOrchestrator(), {
      socketPath,
      pidPath,
      updatePollMs: 0,
    })
    const a = new KobeDaemonClient(socketPath)
    const b = new KobeDaemonClient(socketPath)
    await a.subscribe()
    await b.subscribe()

    a.close()
    // One GUI remains → daemon holds.
    await new Promise((r) => setTimeout(r, GRACE_MS + 150))
    expect(existsSync(socketPath)).toBe(true)

    b.close()
    // Now zero → self-stop.
    expect(await until(() => !existsSync(socketPath), GRACE_MS + 500)).toBe(true)
  })

  it("a re-subscribe within the grace window cancels the pending shutdown", async () => {
    server = await startDaemonServer(fakeOrchestrator(), {
      socketPath,
      pidPath,
      updatePollMs: 0,
    })
    const first = new KobeDaemonClient(socketPath)
    await first.subscribe()
    first.close() // arms the grace timer

    // Reconnect before grace elapses (mirrors manualReconnect's force-drop).
    const second = new KobeDaemonClient(socketPath)
    await second.subscribe()

    await new Promise((r) => setTimeout(r, GRACE_MS + 150))
    expect(existsSync(socketPath)).toBe(true)
    second.close()
  })
})
