import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { KobeDaemonClient } from "../../src/client/index.ts"
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-daemon-"))
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

describe("daemon server", () => {
  test("hello/status/list/spawn round-trip over JSON-lines socket", async () => {
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      const hello = await client.request<{ protocolVersion: number; daemonPid: number; clientId: number }>("hello", {
        clientId: "test",
        version: "test",
      })
      expect(hello.protocolVersion).toBe(1)
      expect(hello.daemonPid).toBe(process.pid)
      expect(hello.clientId).toBe(1)

      const status = await client.request<{ taskCount: number; attachedClients: number }>("daemon.status")
      expect(status.taskCount).toBe(0)
      expect(status.attachedClients).toBe(1)

      const before = await client.request<{ tasks: unknown[] }>("task.list")
      expect(before.tasks).toEqual([])

      const created = await client.request<{ taskId: string; task: { title: string; repo: string } }>("task.spawn", {
        repo,
        title: "daemon task",
      })
      expect(created.taskId).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/i)
      expect(created.task.title).toBe("daemon task")
      expect(created.task.repo).toBe(repo)

      const after = await client.request<{ tasks: Array<{ id: string }> }>("task.list")
      expect(after.tasks.map((t) => t.id)).toContain(created.taskId)
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("hello echoes tasks + pending snapshots so init skips task.list/chat.input.pending", async () => {
    // Regression target: init() used to run hello → task.list →
    // N×chat.input.pending sequentially. Daemon now enriches the
    // hello response with `tasks` and `pending`, collapsing the
    // handshake to hello + subscribe.
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const seed = new KobeDaemonClient(socketPath)
    const probe = new KobeDaemonClient(socketPath)
    try {
      await seed.connect()
      const spawned = await seed.request<{ taskId: string }>("task.spawn", { repo, title: "hello-enriched" })
      const task = orch.getTask(spawned.taskId)
      if (!task) throw new Error("missing task")
      // Plant a pending input directly through the broker so the
      // enriched hello has something non-trivial to echo.
      const broker = (orch as unknown as {
        pendingInputBroker: {
          record: (taskId: string, tabKey: string, requestId: string, payload: unknown) => void
        }
      }).pendingInputBroker
      const payload = {
        kind: "approve_plan" as const,
        plan: "Refactor X.",
        toolName: "ExitPlanMode",
        toolUseId: "tool-hello-1",
      }
      const requestId = "req-hello-1"
      const tabKey = `${spawned.taskId}:${task.activeTabId}`
      broker.record(spawned.taskId, tabKey, requestId, payload)
      const hello = await probe.request<{
        protocolVersion: number
        daemonPid: number
        clientId: number
        tasks: Array<{ id: string; title: string }>
        pending: Record<string, Array<{ requestId: string; payload: unknown; tabKey: string }>>
      }>("hello", { clientId: "probe", version: "test" })
      expect(hello.protocolVersion).toBe(1)
      expect(typeof hello.clientId).toBe("number")
      expect(hello.tasks.map((t) => t.id)).toContain(spawned.taskId)
      expect(hello.pending[spawned.taskId]).toEqual([{ requestId, payload, tabKey }])
    } finally {
      seed.close()
      probe.close()
      await server.close()
      orch.dispose()
    }
  })

  test("broadcasts task.created to attached clients", async () => {
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const a = new KobeDaemonClient(socketPath)
    const b = new KobeDaemonClient(socketPath)
    try {
      await a.connect()
      await b.connect()
      const event = new Promise((resolve) => {
        b.on("task.created", (frame) => resolve(frame.payload))
      })
      const created = await a.request<{ taskId: string }>("task.spawn", { repo, title: "broadcast" })
      await expect(event).resolves.toMatchObject({ task: { id: created.taskId, title: "broadcast" } })
    } finally {
      a.close()
      b.close()
      await server.close()
      orch.dispose()
    }
  })

  test("subscribes ALL attached clients to a freshly spawned task's chat events", async () => {
    // Regression: previously only the spawning client was subscribed
    // to the new task's per-tab event stream, so a second TUI watching
    // the same daemon would see task.created but never receive
    // chat.delta / chat.event for the new task. Multi-attach real-time
    // sync silently broke. The fix iterates `clients` on task.spawn.
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const a = new KobeDaemonClient(socketPath)
    const b = new KobeDaemonClient(socketPath)
    try {
      await a.connect()
      await b.connect()
      const created = await a.request<{ taskId: string }>("task.spawn", { repo, title: "fanout" })
      const delta = new Promise<unknown>((resolve) => {
        b.on("chat.delta", (frame) => resolve(frame.payload))
      })
      const task = orch.getTask(created.taskId)
      if (!task) throw new Error("orchestrator lost the task we just created")
      const tabId = task.activeTabId
      // Drive a fake assistant.delta straight through the orchestrator's
      // dispatch — bypasses the engine subprocess so the test stays
      // hermetic. dispatchEvent is private; use the wider seam: push
      // through respondToInput-style path isn't right either, just
      // subscribe-and-emit via the orchestrator's public bus.
      ;(orch as unknown as { dispatchEvent: (t: string, b: string, ev: unknown) => void }).dispatchEvent(
        created.taskId,
        tabId,
        { type: "assistant.delta", text: "hi from fanout" },
      )
      await expect(delta).resolves.toMatchObject({
        taskId: created.taskId,
        tabId,
        delta: "hi from fanout",
      })
    } finally {
      a.close()
      b.close()
      await server.close()
      orch.dispose()
    }
  })

  test("chat.tab.create does not double-subscribe pre-existing tabs", async () => {
    // Regression: subscribeClientToTask used to iterate every tab on
    // the task; chat.tab.create called it again, so the original tab
    // ended up with N callbacks per delta after N creates. Fix: only
    // subscribe the new tab + dedupe by `${taskId}:${tabId}` key.
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      await client.request("hello", { clientId: "test", version: "test" })
      const spawned = await client.request<{ taskId: string }>("task.spawn", { repo, title: "dupe-sub" })
      const task = orch.getTask(spawned.taskId)
      if (!task) throw new Error("missing task")
      const firstTabId = task.activeTabId
      // Open three more tabs — each call previously re-subscribed
      // every existing tab.
      await client.request("chat.tab.create", { taskId: spawned.taskId })
      await client.request("chat.tab.create", { taskId: spawned.taskId })
      await client.request("chat.tab.create", { taskId: spawned.taskId })
      let deltaCount = 0
      client.on("chat.delta", (frame) => {
        const payload = frame.payload as { tabId: string }
        if (payload.tabId === firstTabId) deltaCount++
      })
      ;(orch as unknown as { dispatchEvent: (t: string, b: string, ev: unknown) => void }).dispatchEvent(
        spawned.taskId,
        firstTabId,
        { type: "assistant.delta", text: "x" },
      )
      // Give the event loop one tick so all wire frames flush.
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(deltaCount).toBe(1)
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("chat.send accepts undefined text (continue/resume path)", async () => {
    // Regression: server used to requireString('text'), which rejected
    // empty payloads. Clients smuggled a single space (' ') sentinel.
    // Now undefined is allowed; orchestrator.runTask receives undefined
    // and resumes without a synthetic prompt.
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      await client.request("hello", { clientId: "test", version: "test" })
      const spawned = await client.request<{ taskId: string }>("task.spawn", { repo, title: "no-text" })
      const seen: unknown[] = []
      const original = orch.runTask.bind(orch)
      ;(orch as unknown as { runTask: typeof orch.runTask }).runTask = async (id, text, tabId) => {
        seen.push(text)
        return original(id, text, tabId)
      }
      await client.request("chat.send", { taskId: spawned.taskId })
      expect(seen).toEqual([undefined])
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("chat.history returns nextBefore token + hasMore for pagination", async () => {
    // Regression: spec described a `before` cursor but the response
    // never included a token, leaving clients with no way to compute
    // the next page. Now chat.history echoes `nextBefore` (constructed
    // from the oldest message in the page) and `hasMore`.
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      await client.request("hello", { clientId: "test", version: "test" })
      const spawned = await client.request<{ taskId: string; task: { activeTabId: string } }>("task.spawn", {
        repo,
        title: "history",
      })
      const task = orch.getTask(spawned.taskId)
      if (!task) throw new Error("missing task")
      // Pre-seed history under the active tab's would-be sessionId by
      // setting the tab's sessionId then seeding the engine.
      const sessionId = "fake-history-1"
      await (orch as unknown as {
        store: { update: (id: string, patch: unknown) => Promise<void> }
      }).store.update(spawned.taskId, {
        tabs: task.tabs.map((t) =>
          t.id === task.activeTabId ? { ...t, sessionId } : t,
        ),
      })
      const fakeEngine = (orch as unknown as { engine: FakeAIEngine }).engine
      const messages = Array.from({ length: 5 }, (_, i) => ({
        role: "user" as const,
        content: `m${i}`,
        timestamp: `2026-05-10T00:00:0${i}.000Z`,
        sessionId,
      }))
      fakeEngine.setHistory(sessionId, messages)
      const page1 = await client.request<{
        messages: typeof messages
        nextBefore: string | null
        hasMore: boolean
      }>("chat.history", { taskId: spawned.taskId, limit: 2 })
      expect(page1.messages).toHaveLength(2)
      expect(page1.hasMore).toBe(true)
      expect(page1.nextBefore).toBe(`${page1.messages[0]?.timestamp}:${sessionId}`)
      const page2 = await client.request<{
        messages: typeof messages
        nextBefore: string | null
        hasMore: boolean
      }>("chat.history", { taskId: spawned.taskId, limit: 2, before: page1.nextBefore })
      expect(page2.messages.map((m) => m.content)).toEqual(["m1", "m2"])
      expect(page2.hasMore).toBe(true)
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("chat.send broadcasts the user prompt to all attached clients as user.inject", async () => {
    // Regression: the chat composer used to push the user row into a
    // local Solid signal before calling runTask, which meant other
    // clients attached to the daemon never received the user message.
    // Two visible symptoms: (a) other windows missed every prompt the
    // typing window sent, (b) without a user row between turns the
    // assistant.delta reducer concatenated separate responses into a
    // single bubble. runTask now emits user.inject on the per-task
    // event bus so it flows through the daemon broadcast like any
    // other event.
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const a = new KobeDaemonClient(socketPath)
    const b = new KobeDaemonClient(socketPath)
    try {
      await a.connect()
      await b.connect()
      const spawned = await a.request<{ taskId: string }>("task.spawn", { repo, title: "fan-out-user" })
      const task = orch.getTask(spawned.taskId)
      if (!task) throw new Error("missing task")
      const tabId = task.activeTabId
      const inject = new Promise<unknown>((resolve) => {
        b.on("chat.event", (frame) => {
          const payload = frame.payload as { event?: { type: string; text?: string } }
          if (payload.event?.type === "user.inject") resolve(payload)
        })
      })
      await a.request("chat.send", { taskId: spawned.taskId, text: "hello from a", tabId })
      await expect(inject).resolves.toMatchObject({
        taskId: spawned.taskId,
        tabId,
        event: { type: "user.inject", text: "hello from a" },
      })
    } finally {
      a.close()
      b.close()
      await server.close()
      orch.dispose()
    }
  })

  test("chat.history returns the requested session's transcript, not the active tab's", async () => {
    // Regression: chat.history used to ignore any tab/session hint and
    // always return the active tab's history. Result on tab switch:
    // every tab loaded its scrollback by calling readHistory, every
    // call returned the active tab's transcript, every tab rendered
    // the same content. Fix: protocol takes an optional sessionId;
    // server honours it before falling back to the active tab.
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      await client.request("hello", { clientId: "test", version: "test" })
      const spawned = await client.request<{ taskId: string }>("task.spawn", { repo, title: "history-tabs" })
      const task = orch.getTask(spawned.taskId)
      if (!task) throw new Error("missing task")
      // Pin two distinct sessions onto two tabs and seed each with a
      // unique fake transcript.
      const created = await client.request<{ tab: { id: string } }>("chat.tab.create", { taskId: spawned.taskId })
      const sidA = "session-tab-a"
      const sidB = "session-tab-b"
      await (orch as unknown as {
        store: { update: (id: string, patch: unknown) => Promise<void> }
      }).store.update(spawned.taskId, {
        tabs: task.tabs.map((t, i) =>
          t.id === task.activeTabId ? { ...t, sessionId: sidA } : t.id === created.tab.id ? { ...t, sessionId: sidB } : t,
        ),
      })
      const fakeEngine = (orch as unknown as { engine: FakeAIEngine }).engine
      fakeEngine.setHistory(sidA, [{ role: "user", content: "from A", timestamp: "2026-05-10T00:00:00.000Z", sessionId: sidA }])
      fakeEngine.setHistory(sidB, [{ role: "user", content: "from B", timestamp: "2026-05-10T00:00:00.000Z", sessionId: sidB }])
      // Active tab is A; ask for B's transcript by passing sidB.
      const pageB = await client.request<{ messages: Array<{ content: string }> }>("chat.history", {
        taskId: spawned.taskId,
        sessionId: sidB,
        limit: 50,
      })
      expect(pageB.messages.map((m) => m.content)).toEqual(["from B"])
      // Sanity: omitting sessionId still resolves the active tab.
      const pageActive = await client.request<{ messages: Array<{ content: string }> }>("chat.history", {
        taskId: spawned.taskId,
        limit: 50,
      })
      expect(pageActive.messages.map((m) => m.content)).toEqual(["from A"])
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("chat.tab.activate broadcasts task.updated so clients learn the new activeTabId", async () => {
    // Regression: chat-tab switching looked broken from the TUI side.
    // The composer flipped activeTabIdLocal optimistically, then
    // Chat's syncTabSubs effect read the stale tasks signal (which
    // still pointed at the old tab because the daemon never
    // broadcast the change) and forced it back. Result: clicking
    // chat 2 visually snapped to chat 2 then immediately reverted.
    // Fix: every task-mutating handler broadcasts task.updated.
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      await client.request("hello", { clientId: "test", version: "test" })
      const spawned = await client.request<{ taskId: string }>("task.spawn", { repo, title: "switch" })
      const created = await client.request<{ tab: { id: string } }>("chat.tab.create", { taskId: spawned.taskId })
      const updatedPromise = new Promise<{ task: { activeTabId: string } }>((resolve) => {
        client.on("task.updated", (frame) => {
          const payload = frame.payload as { task: { activeTabId: string } }
          if (payload.task.activeTabId === created.tab.id) resolve(payload)
        })
      })
      await client.request("chat.tab.activate", { taskId: spawned.taskId, tabId: created.tab.id })
      const evt = await updatedPromise
      expect(evt.task.activeTabId).toBe(created.tab.id)
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })

  test("chat.tab.create broadcasts task.updated so the new tab appears in every client's tab list", async () => {
    // Companion regression: opening a new tab via the workspace
    // strip must surface to other attached windows. Without the
    // task.updated broadcast the spawning client's own tabs mirror
    // also stays empty until next attach.
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const a = new KobeDaemonClient(socketPath)
    const b = new KobeDaemonClient(socketPath)
    try {
      await a.connect()
      await b.connect()
      const spawned = await a.request<{ taskId: string }>("task.spawn", { repo, title: "new-tab-fanout" })
      const updatedOnB = new Promise<{ task: { tabs: Array<{ id: string }> } }>((resolve) => {
        b.on("task.updated", (frame) => {
          const payload = frame.payload as { taskId: string; task: { tabs: Array<{ id: string }> } }
          if (payload.taskId === spawned.taskId && payload.task.tabs.length >= 2) resolve(payload)
        })
      })
      await a.request("chat.tab.create", { taskId: spawned.taskId })
      const evt = await updatedOnB
      expect(evt.task.tabs.length).toBe(2)
    } finally {
      a.close()
      b.close()
      await server.close()
      orch.dispose()
    }
  })

  test("task.deleted clears subscriptions on every client", async () => {
    // Sanity: after deleteTask, no further events for that task should
    // reach attached clients. Belt-and-suspenders for the
    // unsubscribeClientFromTask helper.
    const orch = await buildOrchestrator()
    const server = await startDaemonServer(orch, { socketPath, pidPath, homeDir })
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.connect()
      await client.request("hello", { clientId: "test", version: "test" })
      const spawned = await client.request<{ taskId: string }>("task.spawn", { repo, title: "to-delete" })
      const task = orch.getTask(spawned.taskId)
      if (!task) throw new Error("missing task")
      const tabId = task.activeTabId
      await client.request("task.delete", { taskId: spawned.taskId })
      let postDeleteCount = 0
      client.on("chat.delta", () => postDeleteCount++)
      // Dispatching after delete: orchestrator may have torn the task
      // down already, so this is just a smoke check that no zombie
      // listener fires. The orchestrator silently no-ops on missing
      // task.
      try {
        ;(orch as unknown as { dispatchEvent: (t: string, b: string, ev: unknown) => void }).dispatchEvent(
          spawned.taskId,
          tabId,
          { type: "assistant.delta", text: "after-delete" },
        )
      } catch {
        /* expected — task gone */
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(postDeleteCount).toBe(0)
    } finally {
      client.close()
      await server.close()
      orch.dispose()
    }
  })
})
