/**
 * Socket-takeover guard (prod incident 2026-08-10): `startDaemonServer` used
 * to `unlink(socketPath)` unconditionally, so an autospawned daemon stole the
 * path out from under a healthy incumbent — the incumbent kept serving its
 * already-attached TUI while every NEW connection (engine hooks, `kobe api`)
 * landed on the usurper. Split-brain activity state; sidebar badges vanished
 * for engines that were genuinely mid-turn. The guard probes the socket
 * before binding: a live (hello-answering) owner refuses the boot, a stale
 * leftover file is still cleared like before.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { type DaemonServerOptions, startDaemonServer } from "@sma1lboy/kobe-daemon/daemon/server"
import { describe, expect, it } from "vitest"
import { daemonRuntime } from "../../src/core/daemon-runtime.ts"
import { bootDaemonHarness, fakeOrchestrator, waitFor } from "./harness.ts"

const ZERO_POLLS = {
  updatePollMs: 0,
  autoTitlePollMs: 0,
  prStatusPollMs: 0,
  uiPrefsDebounceMs: 0,
  keybindingsDebounceMs: 0,
  worktreeChangesTickMs: 0,
  transcriptActivityTickMs: 0,
} as const

/** Temp home + isolated socket/pid paths + KOBE_HOME_DIR pinned for the test's
 *  duration, with base server options ready to spread. */
function tempDaemonDir(prefix: string): {
  dir: string
  socketPath: string
  pidPath: string
  base: DaemonServerOptions
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const saved = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = dir
  const socketPath = join(dir, "daemon.sock")
  const pidPath = join(dir, "daemon.pid")
  return {
    dir,
    socketPath,
    pidPath,
    base: { runtime: daemonRuntime, socketPath, pidPath, homeDir: dir, ...ZERO_POLLS },
    cleanup: () => {
      if (saved === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
      else process.env.KOBE_HOME_DIR = saved
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe("daemon socket takeover guard", () => {
  it("refuses to boot onto a socket a live daemon is serving, leaving the incumbent intact", async () => {
    const h = await bootDaemonHarness()
    try {
      await expect(
        startDaemonServer(fakeOrchestrator(), {
          runtime: daemonRuntime,
          socketPath: h.socketPath,
          pidPath: `${h.pidPath}.usurper`,
          homeDir: h.dir,
          ...ZERO_POLLS,
        }),
      ).rejects.toThrow(/already serving/)
      // The incumbent's socket file was NOT unlinked — it still answers.
      const status = await h.client().request<Record<string, unknown>>("daemon.status")
      expect(status).toBeTruthy()
    } finally {
      await h.close()
    }
  })

  it("a daemon whose socket path was clobbered and rebound self-stops so clients can migrate", async () => {
    // The client-side clobber the boot guard can't see: the path is unlinked
    // FIRST (stopDaemonProcess cleanup), so the usurper's boot probe reads
    // "absent" and binds. The incumbent must notice and stop itself — its
    // attached clients' reconnect loops then land on the new owner.
    const { socketPath, pidPath, base, cleanup } = tempDaemonDir("kobe-sock-tko-")
    try {
      let stopped = false
      const incumbent = await startDaemonServer(fakeOrchestrator(), {
        ...base,
        socketWatchMs: 25,
        onStop: async () => {
          stopped = true
        },
      })
      await unlink(socketPath)
      const usurper = await startDaemonServer(fakeOrchestrator(), { ...base, socketWatchMs: 0 })
      expect(await waitFor(() => stopped, 3000)).toBe(true)
      // The superseded daemon's shutdown left the new owner fully intact.
      expect(await waitFor(() => existsSync(socketPath), 3000)).toBe(true)
      expect(existsSync(pidPath)).toBe(true)
      const probe = new KobeDaemonClient(socketPath)
      await probe.connect()
      expect(await probe.request<Record<string, unknown>>("daemon.status")).toBeTruthy()
      probe.close()
      await usurper.close()
      await incumbent.close()
    } finally {
      cleanup()
    }
  })

  it("shutdown cleanup leaves a socket it no longer owns untouched, but still cleans an owned one", async () => {
    const { socketPath, pidPath, base, cleanup } = tempDaemonDir("kobe-sock-own-")
    try {
      const superseded = await startDaemonServer(fakeOrchestrator(), { ...base, socketWatchMs: 0 })
      await unlink(socketPath)
      const owner = await startDaemonServer(fakeOrchestrator(), { ...base, socketWatchMs: 0 })
      await superseded.close()
      // The late close of the superseded daemon deleted NOTHING of the owner's.
      expect(existsSync(socketPath)).toBe(true)
      expect(existsSync(pidPath)).toBe(true)
      const probe = new KobeDaemonClient(socketPath)
      await probe.connect()
      expect(await probe.request<Record<string, unknown>>("daemon.status")).toBeTruthy()
      probe.close()
      // A daemon that still owns its socket cleans up like always.
      await owner.close()
      expect(existsSync(socketPath)).toBe(false)
      expect(existsSync(pidPath)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it("still clears a stale socket file left by a dead daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kobe-sock-stale-"))
    const saved = process.env.KOBE_HOME_DIR
    process.env.KOBE_HOME_DIR = dir
    const socketPath = join(dir, "daemon.sock")
    writeFileSync(socketPath, "") // dead leftover: connect() fails, not a live owner
    try {
      const server = await startDaemonServer(fakeOrchestrator(), {
        runtime: daemonRuntime,
        socketPath,
        pidPath: join(dir, "daemon.pid"),
        homeDir: dir,
        ...ZERO_POLLS,
      })
      expect(server.socketPath).toBe(socketPath)
      await server.close()
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
      else process.env.KOBE_HOME_DIR = saved
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
