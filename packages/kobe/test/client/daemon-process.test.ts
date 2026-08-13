import { existsSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { type Server, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ensureDaemonReachable,
  resolveKobeSpawn,
  testDaemonResponds,
  tryAcquireSpawnLock,
} from "@sma1lboy/kobe-daemon/client/daemon-process"
import { afterEach, describe, expect, it } from "vitest"

// Short paths: macOS caps unix-socket paths at ~104 chars, and tmpdir() can
// be long, so anchor under /tmp where available.
const SOCK_DIR = process.platform === "darwin" ? "/tmp" : tmpdir()
const servers: Server[] = []
const openSockets = new Set<import("node:net").Socket>()
type EventedServer = Server & { once(event: "error", listener: (err: Error) => void): void }

describe("resolveKobeSpawn", () => {
  it("re-enters through the active public wrapper in source mode", () => {
    expect(resolveKobeSpawn(["daemon", "start"], { ROVE_INVOKED_AS: "rove" })).toEqual([
      process.execPath,
      expect.stringMatching(/\/cli\/rove\.ts$/),
      "daemon",
      "start",
    ])
    expect(resolveKobeSpawn(["daemon", "start"], { ROVE_INVOKED_AS: "kobe" })).toEqual([
      process.execPath,
      expect.stringMatching(/\/cli\/kobe\.ts$/),
      "daemon",
      "start",
    ])
  })
})

function listenAt(path: string, handler?: (sock: import("node:net").Socket) => void): Promise<string> {
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
    ;(server as EventedServer).once("error", reject)
    server.listen(path, () => resolve(path))
  })
}

function listen(handler?: (sock: import("node:net").Socket) => void): Promise<string> {
  return listenAt(join(SOCK_DIR, `kobe-dpr-${process.pid}-${servers.length}.sock`), handler)
}

/** Minimal daemon stand-in: answers `hello` and nothing else. */
function helloResponder(sock: import("node:net").Socket): void {
  sock.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const frame = JSON.parse(line) as { id: string; name: string }
      if (frame.name === "hello") {
        sock.write(`${JSON.stringify({ type: "response", id: frame.id, payload: { protocolVersion: 2 } })}\n`)
      }
    }
  })
}

afterEach(async () => {
  for (const sock of openSockets) sock.destroy()
  openSockets.clear()
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

describe("testDaemonResponds", () => {
  it("is true when the daemon answers hello", async () => {
    const path = await listen(helloResponder)
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

describe("tryAcquireSpawnLock", () => {
  it("acquires on a fresh home whose .kobe dir does not exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "kobe-spawn-lock-"))
    try {
      const lock = join(dir, "does-not-exist-yet", ".kobe", "daemon.pid.spawn-lock")
      expect(tryAcquireSpawnLock(lock)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("second acquire loses while the lock is fresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "kobe-spawn-lock-"))
    try {
      const lock = join(dir, "daemon.pid.spawn-lock")
      expect(tryAcquireSpawnLock(lock)).toBe(true)
      expect(tryAcquireSpawnLock(lock)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reclaims a stale lock left by a crashed spawner", () => {
    const dir = mkdtempSync(join(tmpdir(), "kobe-spawn-lock-"))
    try {
      const lock = join(dir, "daemon.pid.spawn-lock")
      expect(tryAcquireSpawnLock(lock)).toBe(true)
      const past = new Date(Date.now() - 60_000)
      utimesSync(lock, past, past)
      expect(tryAcquireSpawnLock(lock)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("ensureDaemonReachable under a held spawn lock", () => {
  it("waits for the winner's daemon instead of stacking a second stop+spawn", async () => {
    // Two clients race after the same daemon drop (the 2026-08-11 twin
    // autospawn). The loser must NOT kill/spawn — it polls until the
    // winner's daemon answers, and never releases the winner's lock.
    const dir = mkdtempSync(join(tmpdir(), "kobe-spawn-wait-"))
    const socketPath = join(SOCK_DIR, `kobe-dpr-wait-${process.pid}.sock`)
    const saved = {
      sock: process.env.KOBE_DAEMON_SOCKET_PATH,
      pid: process.env.KOBE_DAEMON_PID_PATH,
      home: process.env.KOBE_HOME_DIR,
    }
    process.env.KOBE_DAEMON_SOCKET_PATH = socketPath
    process.env.KOBE_DAEMON_PID_PATH = join(dir, "daemon.pid")
    process.env.KOBE_HOME_DIR = dir
    const lock = join(dir, "daemon.pid.spawn-lock")
    writeFileSync(lock, "")
    try {
      // The "winner" brings its daemon up a beat later.
      const timer = setTimeout(() => {
        void listenAt(socketPath, helloResponder)
      }, 300)
      const resolved = await ensureDaemonReachable()
      clearTimeout(timer)
      expect(resolved).toBe(socketPath)
      // Still the winner's lock — the waiter neither spawned nor released it.
      expect(existsSync(lock)).toBe(true)
    } finally {
      for (const [env, value] of [
        ["KOBE_DAEMON_SOCKET_PATH", saved.sock],
        ["KOBE_DAEMON_PID_PATH", saved.pid],
        ["KOBE_HOME_DIR", saved.home],
      ] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, env)
        else process.env[env] = value
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
