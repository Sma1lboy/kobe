/**
 * Daemon RPC handler tests — covers the sprint-4 wiring of the six
 * rpc.* verbs through the live daemon socket. Mirrors the
 * `server.test.ts` pattern (real Orchestrator + KobeDaemonClient, real
 * unix socket) instead of inventing a parallel fake-orch harness.
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { KobeDaemonClient } from "../../src/client/index.ts"
import type { DaemonPaneStashAdapter } from "../../src/daemon/server.ts"
import { fallbackTestSocketPath } from "../../src/daemon/paths.ts"
import { startDaemonServer } from "../../src/daemon/server.ts"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { MetadataSuggester } from "../../src/orchestrator/metadata-suggester.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import { FakeAIEngine } from "../behavior/fake-engine.ts"

const REPO_INIT = path.resolve(__dirname, "../behavior/fixtures/repo-init.sh")

let tmpRoot: string
let homeDir: string
let repo: string
let socketPath: string
let pidPath: string

class NoopMetadataSuggester extends MetadataSuggester {
  override async suggestBranchSlug(): Promise<string | null> {
    return null
  }

  override async suggestTitle(): Promise<string | null> {
    return null
  }

  override async suggestWorktreeSlug(): Promise<string | null> {
    return null
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-rpc-"))
  homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  repo = path.join(tmpRoot, "repo")
  socketPath = fallbackTestSocketPath(`kobe-rpc-${path.basename(tmpRoot)}`)
  pidPath = path.join(tmpRoot, "daemon.pid")
  const result = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`repo-init.sh failed: ${result.stderr}\n${result.stdout}`)
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

async function buildOrchestrator(engine = new FakeAIEngine()): Promise<Orchestrator> {
  const store = new TaskIndexStore({ homeDir })
  await store.load()
  return new Orchestrator({
    engine,
    store,
    worktrees: new GitWorktreeManager(),
    metadataSuggester: new NoopMetadataSuggester(),
  })
}

describe("daemon rpc.* handlers", () => {
  test("hello payload includes activeTaskId (null when nothing set)", async () => {
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      const hello = await client.request<{ activeTaskId: string | null }>("hello", {
        clientId: "test",
        version: "test",
      })
      expect(hello.activeTaskId).toBeNull()
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("rpc.switchTask sets active + broadcasts active.changed", async () => {
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const driver = new KobeDaemonClient(socketPath)
    const watcher = new KobeDaemonClient(socketPath)
    try {
      await driver.connect()
      await watcher.connect()
      const spawned = await driver.request<{ taskId: string }>("task.spawn", { repo, title: "switch" })
      const changed = new Promise<{ activeTaskId: string | null }>((resolve) => {
        watcher.on("active.changed", (frame) => resolve(frame.payload as { activeTaskId: string | null }))
      })
      const result = await driver.request<{ ok: boolean; activeTaskId: string }>("rpc.switchTask", {
        id: spawned.taskId,
      })
      expect(result.ok).toBe(true)
      expect(result.activeTaskId).toBe(spawned.taskId)
      await expect(changed).resolves.toEqual({ activeTaskId: spawned.taskId })
    } finally {
      driver.close()
      watcher.close()
      await server.close()
      orch.dispose()
    }
  })

  test("rpc.switchTask throws on unknown task", async () => {
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      await expect(client.request("rpc.switchTask", { id: "no-such-task" })).rejects.toThrow(/unknown task/)
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("rpc.nextTask / rpc.prevTask cycle through non-archived tasks", async () => {
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      const a = await client.request<{ taskId: string }>("task.spawn", { repo, title: "a" })
      const b = await client.request<{ taskId: string }>("task.spawn", { repo, title: "b" })
      const c = await client.request<{ taskId: string }>("task.spawn", { repo, title: "c" })
      // Start by selecting `a` explicitly.
      await client.request("rpc.switchTask", { id: a.taskId })
      // Cycle forward — listTasks order depends on creation order so we
      // collect ids and assert ring membership in order.
      const r1 = await client.request<{ activeTaskId: string }>("rpc.nextTask")
      const r2 = await client.request<{ activeTaskId: string }>("rpc.nextTask")
      const r3 = await client.request<{ activeTaskId: string }>("rpc.nextTask")
      // All three ids visited starting at `a` → cycle returns to `a`.
      const visited = [r1.activeTaskId, r2.activeTaskId, r3.activeTaskId]
      const all = new Set([a.taskId, b.taskId, c.taskId])
      expect(new Set(visited)).toEqual(all)
      // After three forward steps we're back at the start.
      expect(visited[2]).toBe(a.taskId)
      // Going backwards once flips to the previous in cycle.
      const back = await client.request<{ activeTaskId: string }>("rpc.prevTask")
      expect(back.activeTaskId).toBe(visited[1])
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("rpc.nextTask is a no-op when no tasks exist", async () => {
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      const r = await client.request<{ activeTaskId: string | null }>("rpc.nextTask")
      expect(r.activeTaskId).toBeNull()
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("rpc.newTab appends a tab on the active task and activates it", async () => {
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      const spawned = await client.request<{ taskId: string }>("task.spawn", { repo, title: "new-tab" })
      await client.request("rpc.switchTask", { id: spawned.taskId })
      const before = orch.getTask(spawned.taskId)
      if (!before) throw new Error("missing task")
      const tabCountBefore = before.tabs.length
      const result = await client.request<{ ok: boolean; tabId: string }>("rpc.newTab")
      const after = orch.getTask(spawned.taskId)
      if (!after) throw new Error("missing task")
      expect(after.tabs.length).toBe(tabCountBefore + 1)
      expect(after.activeTabId).toBe(result.tabId)
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("rpc.newTab throws when no active task is set", async () => {
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      await expect(client.request("rpc.newTab")).rejects.toThrow(/no active task/)
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("rpc.closeTab silently no-ops when the active task only has one tab", async () => {
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      const spawned = await client.request<{ taskId: string }>("task.spawn", { repo, title: "single" })
      await client.request("rpc.switchTask", { id: spawned.taskId })
      const result = await client.request<{ ok: boolean; skipped?: string }>("rpc.closeTab")
      expect(result.ok).toBe(true)
      expect(result.skipped).toBe("only-one-tab")
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("rpc.closeTab closes the active tab when ≥2 tabs exist", async () => {
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      const spawned = await client.request<{ taskId: string }>("task.spawn", { repo, title: "two-tab" })
      await client.request("rpc.switchTask", { id: spawned.taskId })
      await client.request("rpc.newTab")
      const before = orch.getTask(spawned.taskId)
      if (!before) throw new Error("missing task")
      expect(before.tabs.length).toBe(2)
      const result = await client.request<{ ok: boolean; nextActive: string }>("rpc.closeTab")
      expect(result.ok).toBe(true)
      const after = orch.getTask(spawned.taskId)
      if (!after) throw new Error("missing task")
      expect(after.tabs.length).toBe(1)
      expect(after.activeTabId).toBe(result.nextActive)
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("rpc.switchTab accepts a 1-based numeric index", async () => {
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      const spawned = await client.request<{ taskId: string }>("task.spawn", { repo, title: "index" })
      await client.request("rpc.switchTask", { id: spawned.taskId })
      await client.request("rpc.newTab")
      const task = orch.getTask(spawned.taskId)
      if (!task) throw new Error("missing task")
      expect(task.tabs.length).toBe(2)
      const firstTabId = task.tabs[0]?.id
      const result = await client.request<{ ok: boolean; tabId: string }>("rpc.switchTab", { tabId: "1" })
      expect(result.ok).toBe(true)
      expect(result.tabId).toBe(firstTabId)
      const after = orch.getTask(spawned.taskId)
      expect(after?.activeTabId).toBe(firstTabId)
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("rpc.switchTab returns skipped:out-of-range for an out-of-range numeric index", async () => {
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      const spawned = await client.request<{ taskId: string }>("task.spawn", { repo, title: "oob" })
      await client.request("rpc.switchTask", { id: spawned.taskId })
      const result = await client.request<{ ok: boolean; skipped?: string }>("rpc.switchTab", { tabId: "9" })
      expect(result.ok).toBe(true)
      expect(result.skipped).toBe("out-of-range")
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("rpc verbs call the pane-stash adapter when present", async () => {
    const calls: { method: string; args: unknown[] }[] = []
    let nextPaneId = 100
    const adapter: DaemonPaneStashAdapter = {
      async ensureSpawnedForTab(taskId, tabId, command) {
        calls.push({ method: "ensureSpawnedForTab", args: [taskId, tabId, command] })
        return `%${nextPaneId++}`
      },
      async swapToChat(taskId, tabId) {
        calls.push({ method: "swapToChat", args: [taskId, tabId] })
      },
      async killForTab(taskId, tabId) {
        calls.push({ method: "killForTab", args: [taskId, tabId] })
      },
    }
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, {
      socketPath,
      pidPath,
      homeDir,
      paneStashAdapter: adapter,
      resolveChatPaneCommand: (taskId, tabId) => `exec claude --task ${taskId} --tab ${tabId}`,
    })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      const spawned = await client.request<{ taskId: string }>("task.spawn", { repo, title: "adapter" })
      const taskBefore = orch.getTask(spawned.taskId)
      if (!taskBefore) throw new Error("missing task after spawn")
      const tab1 = taskBefore.activeTabId
      // 1. rpc.switchTask → swap to the current active tab.
      await client.request("rpc.switchTask", { id: spawned.taskId })
      // 2. rpc.newTab → ensureSpawnedForTab + swapToChat for the new tab.
      const newTab = await client.request<{ tabId: string }>("rpc.newTab")
      // 3. rpc.switchTab back to tab1.
      await client.request("rpc.switchTab", { tabId: tab1 })
      // 4. rpc.closeTab — closes the currently-active tab (= tab1), then
      //    swaps to next + kills tab1's pane.
      await client.request("rpc.closeTab")

      const swapCalls = calls.filter((c) => c.method === "swapToChat")
      const ensureCalls = calls.filter((c) => c.method === "ensureSpawnedForTab")
      const killCalls = calls.filter((c) => c.method === "killForTab")

      // rpc.switchTask + rpc.newTab + rpc.switchTab + rpc.closeTab = 4 swaps.
      expect(swapCalls).toHaveLength(4)
      expect(swapCalls[0]?.args).toEqual([spawned.taskId, tab1])
      expect(swapCalls[1]?.args).toEqual([spawned.taskId, newTab.tabId])
      expect(swapCalls[2]?.args).toEqual([spawned.taskId, tab1])
      // After closeTab, the orchestrator moves active to the next tab; we
      // don't assert the specific id, just that swap was driven for it.
      expect(swapCalls[3]?.args[0]).toBe(spawned.taskId)
      expect(swapCalls[3]?.args[1]).toBe(newTab.tabId)

      // rpc.newTab triggered exactly one ensureSpawnedForTab for the new tab.
      expect(ensureCalls).toHaveLength(1)
      expect(ensureCalls[0]?.args).toEqual([
        spawned.taskId,
        newTab.tabId,
        `exec claude --task ${spawned.taskId} --tab ${newTab.tabId}`,
      ])

      // rpc.closeTab triggered exactly one killForTab for the closed tab.
      expect(killCalls).toHaveLength(1)
      expect(killCalls[0]?.args).toEqual([spawned.taskId, tab1])
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("rpc verbs are silent no-ops when the pane-stash adapter is absent", async () => {
    // Regression: production daemons (sprint-5 default) construct no
    // adapter. The rpc verbs must still succeed and mutate orchestrator
    // state without throwing or hanging on a missing adapter.
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      const spawned = await client.request<{ taskId: string }>("task.spawn", { repo, title: "no-adapter" })
      await client.request("rpc.switchTask", { id: spawned.taskId })
      await client.request("rpc.newTab")
      await client.request("rpc.closeTab")
      // Orchestrator state intact even without the adapter.
      const after = orch.getTask(spawned.taskId)
      expect(after?.tabs).toHaveLength(1)
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("task.delete clears active when the deleted task was the active one", async () => {
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      const spawned = await client.request<{ taskId: string }>("task.spawn", { repo, title: "to-delete" })
      await client.request("rpc.switchTask", { id: spawned.taskId })
      await client.request("task.delete", { taskId: spawned.taskId })
      const hello = await client.request<{ activeTaskId: string | null }>("hello", { clientId: "test" })
      expect(hello.activeTaskId).toBeNull()
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })
})
