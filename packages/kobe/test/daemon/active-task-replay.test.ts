/**
 * Connect-time replay of the restored focus (`active-task` channel).
 *
 * Why this matters: the orchestrator seeds its active-task signal from the
 * persisted `lastActive` record, but the channel used to be published only
 * by the `task.setActive` handler — a FRESH daemon replayed tasks with no
 * focus, so every newly attached TUI fell back to "first task in the list"
 * instead of the last focused one (the "opens on the wrong task" bug).
 * The server now warms the channel at startup; this pins that behavior
 * over the real Unix socket.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { type DaemonServer, startDaemonServer } from "@sma1lboy/kobe-daemon/daemon/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Orchestrator } from "../../src/orchestrator/core.ts"

/** Minimal orchestrator whose restored focus is `taskId`. */
function fakeOrchestrator(taskId: string | null): Orchestrator {
  return {
    subscribeTasks: (listener: (snapshot: unknown[]) => void) => {
      listener([])
      return () => {}
    },
    listTasks: () => [],
    activeTaskSignal: () => () => taskId,
  } as unknown as Orchestrator
}

async function waitFor(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe("active-task connect-time replay", () => {
  let dir: string
  let socketPath: string
  let pidPath: string
  let server: DaemonServer | null
  let savedHome: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kobe-active-replay-"))
    socketPath = join(dir, "daemon.sock")
    pidPath = join(dir, "daemon.pid")
    savedHome = process.env.KOBE_HOME_DIR
    process.env.KOBE_HOME_DIR = dir
    server = null
  })

  afterEach(async () => {
    if (savedHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
    else process.env.KOBE_HOME_DIR = savedHome
    await server?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })

  async function replayedActiveTask(orch: Orchestrator): Promise<string | null | undefined> {
    server = await startDaemonServer(orch, {
      socketPath,
      pidPath,
      homeDir: dir,
      updatePollMs: 0,
      autoTitlePollMs: 0,
      uiPrefsDebounceMs: 0,
      keybindingsDebounceMs: 25,
      worktreeChangesTickMs: 0,
    })
    const client = new KobeDaemonClient(socketPath)
    let seen: string | null | undefined
    let arrived = false
    client.on("active-task", (frame) => {
      seen = (frame.payload as { taskId?: string | null }).taskId
      arrived = true
    })
    await client.subscribe()
    await waitFor(() => arrived)
    client.close()
    return arrived ? seen : undefined
  }

  it("a fresh daemon replays the orchestrator's restored focus", async () => {
    expect(await replayedActiveTask(fakeOrchestrator("task-42"))).toBe("task-42")
  })

  it("no persisted focus replays an explicit null, not a cold channel", async () => {
    expect(await replayedActiveTask(fakeOrchestrator(null))).toBeNull()
  })
})
