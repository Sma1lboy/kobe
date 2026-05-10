/**
 * RemoteOrchestrator regression tests.
 *
 * These cover the half of the daemon contract the server.test.ts suite
 * doesn't reach: how the client side hydrates from + reacts to wire
 * events. The two cases here are the two the daemon-protocol code
 * review flagged as broken — peekPendingInput pulled from
 * `chat.input.pending` on attach, and `task.updated` accepting the
 * payload field rename (`patch` → `task`).
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { KobeDaemonClient } from "../../src/client/index.ts"
import { RemoteOrchestrator } from "../../src/client/remote-orchestrator.ts"
import { startDaemonServer } from "../../src/daemon/server.ts"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import { FakeAIEngine } from "../behavior/fake-engine.ts"

const REPO_INIT = path.resolve(__dirname, "../behavior/fixtures/repo-init.sh")

let tmpRoot: string
let homeDir: string
let repo: string
let socketPath: string
let pidPath: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-remote-orch-"))
  homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  repo = path.join(tmpRoot, "repo")
  socketPath = path.join(tmpRoot, "daemon.sock")
  pidPath = path.join(tmpRoot, "daemon.pid")
  const result = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`repo-init.sh failed: ${result.stderr}\n${result.stdout}`)
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

async function buildOrchestrator(): Promise<Orchestrator> {
  const store = new TaskIndexStore({ homeDir })
  await store.load()
  return new Orchestrator({ engine: new FakeAIEngine(), store, worktrees: new GitWorktreeManager() })
}

describe("RemoteOrchestrator", () => {
  test("hydrates peekPendingInput from chat.input.pending on attach", async () => {
    // Regression: peekPendingInput on RemoteOrchestrator was a stub
    // that returned []. A TUI joining a daemon with an in-flight
    // user_input.request would not see it, so the composer wouldn't
    // lock and the picker wouldn't render. The fix queries
    // chat.input.pending per task during init().
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const driverClient = new KobeDaemonClient(socketPath)
    const remoteClient = new KobeDaemonClient(socketPath)
    let remote: RemoteOrchestrator | null = null
    try {
      await driverClient.connect()
      const spawned = await driverClient.request<{ taskId: string }>("task.spawn", {
        repo,
        title: "pending-input",
      })
      const task = orch.getTask(spawned.taskId)
      if (!task) throw new Error("missing task")
      // Synthesize a pending-input bucket entry directly. The fake
      // engine doesn't run user-input tools, so we plant the state the
      // way the orchestrator would after detecting one at runtime.
      // Records through the broker now that the orchestrator delegates
      // its pending-input bucket — see `src/orchestrator/pending-input-broker.ts`.
      const broker = (orch as unknown as {
        pendingInputBroker: {
          record: (taskId: string, tabKey: string, requestId: string, payload: unknown) => void
        }
      }).pendingInputBroker
      const requestId = "req-test-1"
      const payload = {
        kind: "approve_plan" as const,
        plan: "Refactor module X.",
        toolName: "ExitPlanMode",
        toolUseId: "tool-1",
      }
      broker.record(spawned.taskId, `${spawned.taskId}:${task.activeTabId}`, requestId, payload)
      // Now attach a fresh remote — init() should pick up the pending
      // request on its own.
      remote = new RemoteOrchestrator(remoteClient)
      await remote.init()
      const pending = remote.peekPendingInput(spawned.taskId)
      expect(pending).toEqual([{ requestId, payload, tabKey: `${spawned.taskId}:${task.activeTabId}` }])
    } finally {
      remote?.dispose()
      driverClient.close()
      await server.close()
      orch.dispose()
    }
  })

  test("task.updated payload uses `task` not `patch`", async () => {
    // Cosmetic-but-load-bearing: the wire field used to be named
    // `patch` but always carried the full task. Renaming to `task`
    // keeps the protocol honest. RemoteOrchestrator.handleEvent must
    // read the new key.
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const driverClient = new KobeDaemonClient(socketPath)
    const remoteClient = new KobeDaemonClient(socketPath)
    let remote: RemoteOrchestrator | null = null
    try {
      await driverClient.connect()
      const spawned = await driverClient.request<{ taskId: string }>("task.spawn", {
        repo,
        title: "before-rename",
      })
      remote = new RemoteOrchestrator(remoteClient)
      await remote.init()
      // Drive a rename through the daemon. RemoteOrchestrator should
      // upsert the renamed task into its tasks signal — proves the
      // event handler read `task` off the payload.
      const updated = new Promise<void>((resolve) => {
        const check = () => {
          const t = remote?.getTask(spawned.taskId)
          if (t?.title === "after-rename") resolve()
          else setTimeout(check, 5)
        }
        check()
      })
      await driverClient.request("task.rename", { taskId: spawned.taskId, title: "after-rename" })
      await updated
      expect(remote.getTask(spawned.taskId)?.title).toBe("after-rename")
    } finally {
      remote?.dispose()
      driverClient.close()
      await server.close()
      orch.dispose()
    }
  })

  test("user_input.request/resolved events update peekPendingInput", async () => {
    // Once attached, RemoteOrchestrator must mirror the daemon's
    // pending-input bucket forward by reacting to user_input.request
    // (push) and user_input.resolved (drop). Without this the
    // composer would re-lock once but never unlock.
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const driverClient = new KobeDaemonClient(socketPath)
    const remoteClient = new KobeDaemonClient(socketPath)
    let remote: RemoteOrchestrator | null = null
    try {
      await driverClient.connect()
      const spawned = await driverClient.request<{ taskId: string }>("task.spawn", { repo, title: "live-input" })
      const task = orch.getTask(spawned.taskId)
      if (!task) throw new Error("missing task")
      const tabId = task.activeTabId
      remote = new RemoteOrchestrator(remoteClient)
      await remote.init()
      const requestId = "req-live-1"
      const payload = {
        kind: "approve_plan" as const,
        plan: "Test plan.",
        toolName: "ExitPlanMode",
        toolUseId: "tool-live-1",
      }
      ;(orch as unknown as { dispatchEvent: (t: string, b: string, ev: unknown) => void }).dispatchEvent(
        spawned.taskId,
        tabId,
        { type: "user_input.request", requestId, payload },
      )
      await waitFor(() => remote!.peekPendingInput(spawned.taskId).length === 1)
      expect(remote.peekPendingInput(spawned.taskId)).toEqual([
        { requestId, payload, tabKey: `${spawned.taskId}:${tabId}` },
      ])
      ;(orch as unknown as { dispatchEvent: (t: string, b: string, ev: unknown) => void }).dispatchEvent(
        spawned.taskId,
        tabId,
        { type: "user_input.resolved", requestId, response: { kind: "approve_plan", approve: true } },
      )
      await waitFor(() => remote!.peekPendingInput(spawned.taskId).length === 0)
      expect(remote.peekPendingInput(spawned.taskId)).toEqual([])
    } finally {
      remote?.dispose()
      driverClient.close()
      await server.close()
      orch.dispose()
    }
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("waitFor timed out")
}
