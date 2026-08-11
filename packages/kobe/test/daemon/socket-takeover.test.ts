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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDaemonServer } from "@sma1lboy/kobe-daemon/daemon/server"
import { describe, expect, it } from "vitest"
import { daemonRuntime } from "../../src/core/daemon-runtime.ts"
import { bootDaemonHarness, fakeOrchestrator } from "./harness.ts"

const ZERO_POLLS = {
  updatePollMs: 0,
  autoTitlePollMs: 0,
  prStatusPollMs: 0,
  uiPrefsDebounceMs: 0,
  keybindingsDebounceMs: 0,
  worktreeChangesTickMs: 0,
  transcriptActivityTickMs: 0,
} as const

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
