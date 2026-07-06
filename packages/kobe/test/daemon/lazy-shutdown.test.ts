import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { type DaemonServer, startDaemonServer } from "@sma1lboy/kobe-daemon/daemon/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Orchestrator } from "../../src/orchestrator/core.ts"

const GRACE_MS = 80

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
    await client.subscribe({ role: "gui" })
    expect(existsSync(socketPath)).toBe(true)

    client.close()
    expect(await until(() => !existsSync(socketPath), GRACE_MS + 500)).toBe(true)
    expect(await until(() => !existsSync(pidPath), 500)).toBe(true)
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

    await new Promise((r) => setTimeout(r, GRACE_MS + 150))
    expect(existsSync(socketPath)).toBe(true)
  })

  it("stays up for a transient, never-subscribed connection (default subscribe is pane)", async () => {
    server = await startDaemonServer(fakeOrchestrator(), { socketPath, pidPath, updatePollMs: 0 })
    const pane = new KobeDaemonClient(socketPath)
    await pane.subscribe()
    pane.close()
    await new Promise((r) => setTimeout(r, GRACE_MS + 150))
    expect(existsSync(socketPath)).toBe(true)
    pane.close()
  })

  it("panes never hold the daemon alive after the gui quits", async () => {
    server = await startDaemonServer(fakeOrchestrator(), { socketPath, pidPath, updatePollMs: 0 })
    const gui = new KobeDaemonClient(socketPath)
    const pane1 = new KobeDaemonClient(socketPath)
    const pane2 = new KobeDaemonClient(socketPath)
    await gui.subscribe({ role: "gui" })
    await pane1.subscribe({ role: "pane" })
    await pane2.subscribe({ role: "pane" })

    gui.close()
    expect(await until(() => !existsSync(socketPath), GRACE_MS + 500)).toBe(true)
    pane1.close()
    pane2.close()
  })

  it("a pane subscribing during the grace window does NOT cancel shutdown", async () => {
    server = await startDaemonServer(fakeOrchestrator(), { socketPath, pidPath, updatePollMs: 0 })
    const gui = new KobeDaemonClient(socketPath)
    await gui.subscribe({ role: "gui" })
    gui.close()

    const pane = new KobeDaemonClient(socketPath)
    await pane.subscribe({ role: "pane" })

    expect(await until(() => !existsSync(socketPath), GRACE_MS + 500)).toBe(true)
    pane.close()
  })

  it("only stops once the LAST of several subscribers leaves", async () => {
    server = await startDaemonServer(fakeOrchestrator(), {
      socketPath,
      pidPath,
      updatePollMs: 0,
    })
    const a = new KobeDaemonClient(socketPath)
    const b = new KobeDaemonClient(socketPath)
    await a.subscribe({ role: "gui" })
    await b.subscribe({ role: "gui" })

    a.close()
    await new Promise((r) => setTimeout(r, GRACE_MS + 150))
    expect(existsSync(socketPath)).toBe(true)

    b.close()
    expect(await until(() => !existsSync(socketPath), GRACE_MS + 500)).toBe(true)
  })

  it("a re-subscribe within the grace window cancels the pending shutdown", async () => {
    server = await startDaemonServer(fakeOrchestrator(), {
      socketPath,
      pidPath,
      updatePollMs: 0,
    })
    const first = new KobeDaemonClient(socketPath)
    await first.subscribe({ role: "gui" })
    first.close()

    const second = new KobeDaemonClient(socketPath)
    await second.subscribe({ role: "gui" })

    await new Promise((r) => setTimeout(r, GRACE_MS + 150))
    expect(existsSync(socketPath)).toBe(true)
    second.close()
  })
})
