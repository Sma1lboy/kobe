/**
 * Server-level freeze/restore — the REAL restart story, over the wire:
 * host A serves a session, the host process ends (close(), the idle-exit /
 * SIGTERM shape), host B boots against the same freeze dir and must list
 * the session as a restored corpse with its scrollback, and the first
 * `pty.open` must respawn it in place. The second pin is `daemon.stop`
 * (rove reset's graceful path): it must WIPE the store so the next host
 * comes up empty — "starts fresh" is reset's contract.
 *
 * A fake driver keeps this deterministic under vitest (no real PTY); the
 * socket, protocol, freeze-store files, and server lifecycle are all real.
 * KOBE_HOME_DIR is redirected so the exit-record side write lands in the
 * temp home, never the operator's.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import type { PtyOpenResult, PtySessionExit } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { PtyChild, PtyDriver, PtyExit } from "@sma1lboy/kobe-daemon/daemon/pty-driver"
import { type PtyHostServer, startPtyHostServer } from "@sma1lboy/kobe-daemon/daemon/pty-server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let dir: string
let socketPath: string
let pidPath: string
let freezeDir: string
let savedHome: string | undefined
const servers: PtyHostServer[] = []
const clients: KobeDaemonClient[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kobe-pty-restart-"))
  socketPath = join(dir, "pty.sock")
  pidPath = join(dir, "pty.pid")
  freezeDir = join(dir, "pty-sessions")
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

class FakeChild {
  static nextPid = 2000
  readonly pid = FakeChild.nextPid++
  private settle!: (exit: PtyExit) => void
  readonly exited = new Promise<PtyExit>((resolve) => {
    this.settle = resolve
  })
  constructor(private readonly onData: (data: string | Uint8Array) => void) {}
  write(data: string): void {
    this.onData(data) // echo
  }
  resize(): void {}
  close(): void {}
  kill(signal: NodeJS.Signals): void {
    this.settle({ code: null, signal })
  }
}

const fakeDriver: PtyDriver = (request) => new FakeChild(request.onData) as unknown as PtyChild

async function bootHost(): Promise<PtyHostServer> {
  const server = await startPtyHostServer({ socketPath, pidPath, freezeDir, driver: fakeDriver, idleExitMs: 60_000 })
  servers.push(server)
  return server
}

async function connect(): Promise<KobeDaemonClient> {
  const client = new KobeDaemonClient(socketPath)
  await client.connect()
  clients.push(client)
  return client
}

interface ListRow {
  key: string
  alive: boolean
  restored?: boolean
  exit?: PtySessionExit | null
}

describe("pty-host server freeze/restore across a restart", () => {
  it("a restarted host lists the frozen corpse and respawns it on open, scrollback intact", async () => {
    await bootHost()
    const a = await connect()
    const opened = await a.request<PtyOpenResult>("pty.open", {
      key: "t1::tab-1",
      cwd: "/wt/t1",
      command: ["/bin/cat"],
    })
    expect(opened.created).toBe(true)
    await a.request("pty.write", { key: "t1::tab-1", data: "scene-of-the-work\n" })

    // Host process ends (idle-exit / SIGTERM shape): children die, records stay.
    await servers.splice(0)[0].close()
    a.close()

    await bootHost()
    const b = await connect()
    const listed = await b.request<{ sessions: ListRow[] }>("pty.list", {})
    expect(listed.sessions).toHaveLength(1)
    expect(listed.sessions[0]).toMatchObject({ key: "t1::tab-1", alive: false, restored: true })

    const reattached = await b.request<PtyOpenResult>("pty.open", {
      key: "t1::tab-1",
      cwd: "/wt/t1",
      command: ["/bin/cat"],
    })
    expect(reattached).toMatchObject({ alive: true, created: false, respawned: true })
    expect(Buffer.from(reattached.replay, "base64").toString("utf8")).toContain("scene-of-the-work")
  })

  it("daemon.stop (rove reset) WIPES the freeze store — the next host comes up empty", async () => {
    await bootHost()
    const a = await connect()
    await a.request("pty.open", { key: "t1::tab-1", cwd: "/wt/t1", command: ["/bin/cat"] })
    await a.request("pty.write", { key: "t1::tab-1", data: "x" })
    await a.request("daemon.stop", {})
    // The stop is scheduled on a macrotask; wait for the socket to go away.
    const deadline = Date.now() + 3000
    for (;;) {
      await new Promise((r) => setTimeout(r, 25))
      const probe = new KobeDaemonClient(socketPath)
      const up = await probe.connect().then(
        () => true,
        () => false,
      )
      probe.close()
      if (!up) break
      if (Date.now() > deadline) throw new Error("host did not stop")
    }

    await bootHost()
    const b = await connect()
    const listed = await b.request<{ sessions: ListRow[] }>("pty.list", {})
    expect(listed.sessions).toEqual([])
  })
})
