import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import { SessionBindingStore } from "@sma1lboy/kobe-daemon/daemon/session-bindings"
import { describe, expect, it } from "vitest"

async function fixture(nowValues = [100, 200, 300, 400]) {
  const dir = await mkdtemp(join(tmpdir(), "kobe-session-bindings-"))
  const path = join(dir, "session-bindings.json")
  const bus = new DaemonEventBus()
  let index = 0
  const store = new SessionBindingStore(path, bus, () => nowValues[index++] ?? 999)
  await store.init()
  return { path, bus, store }
}

describe("SessionBindingStore", () => {
  it("persists pending -> bound -> ended across daemon instances", async () => {
    const { path, bus, store } = await fixture()

    await store.begin("task-1", "tab-a", "codex")
    expect(store.snapshotByTask()["task-1"]?.["tab-a"]).toMatchObject({
      sessionId: null,
      state: "pending",
      source: "spawn",
      startedAt: 100,
    })

    await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "019f-session",
      source: "hook",
      eventKind: "session-start",
      startSource: "startup",
      transcriptPath: "/tmp/rollout.jsonl",
    })
    await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "019f-session",
      source: "hook",
      state: "ended",
      eventKind: "session-end",
    })

    const reloaded = new SessionBindingStore(path, new DaemonEventBus())
    await reloaded.init()
    expect(reloaded.snapshotByTask()["task-1"]?.["tab-a"]).toMatchObject({
      sessionId: "019f-session",
      runId: expect.any(String),
      state: "ended",
      source: "hook",
      startSource: "startup",
      startedAt: 100,
      boundAt: 200,
      updatedAt: 300,
    })
    expect(reloaded.sessionIdsByTask()).toEqual({
      "task-1": { "tab-a": "019f-session" },
    })
    expect(bus.snapshot().at(-1)).toEqual({
      channel: "session.bindings",
      payload: { bindings: store.snapshotByTask() },
    })
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 2 })
  })

  it("a new spawn on the same tab replaces the old session identity", async () => {
    const { store } = await fixture()
    await store.begin("task-1", "tab-a", "claude")
    await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "claude",
      sessionId: "old",
      source: "spawn",
    })
    await store.begin("task-1", "tab-a", "codex")
    expect(store.snapshotByTask()["task-1"]?.["tab-a"]).toMatchObject({
      vendor: "codex",
      sessionId: null,
      state: "pending",
      startedAt: 300,
    })
  })

  it("begins a new run for a new same-vendor PTY spawn and deduplicates pending reads", async () => {
    const { store } = await fixture()
    const initial = await store.begin("task-1", "tab-a", "codex")
    await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "existing",
      source: "hook",
    })
    const pending = await store.begin("task-1", "tab-a", "codex")

    expect(pending.runId).not.toBe(initial.runId)
    expect(pending).toMatchObject({ sessionId: null, state: "pending", startedAt: 300 })
    expect(await store.begin("task-1", "tab-a", "codex")).toEqual(pending)
    expect(store.snapshotByTask()["task-1"]?.["tab-a"]).toEqual(pending)
  })

  it("lets Claude's SessionStart confirm a caller-pinned spawn without duplicating its run", async () => {
    const { store } = await fixture()
    const pending = await store.begin("task-1", "tab-a", "claude")
    const pinned = await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "claude",
      sessionId: "caller-assigned",
      source: "spawn",
    })
    const confirmed = await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "claude",
      sessionId: "caller-assigned",
      source: "hook",
      eventKind: "session-start",
      startSource: "startup",
    })

    expect(pinned.runId).toBe(pending.runId)
    expect(confirmed.runId).toBe(pending.runId)
    expect(confirmed).toMatchObject({ source: "hook", startSource: "startup" })
    expect(store.runsSnapshot()).toHaveLength(1)
  })

  it("creates a new run when the same native session is resumed, but not when it compacts", async () => {
    const { store } = await fixture()
    await store.begin("task-1", "tab-a", "codex")
    const startup = await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "same-session",
      source: "hook",
      eventKind: "session-start",
      startSource: "startup",
    })
    const resumed = await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "same-session",
      source: "hook",
      eventKind: "session-start",
      startSource: "resume",
    })
    const compacted = await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "same-session",
      source: "hook",
      eventKind: "session-start",
      startSource: "compact",
    })

    expect(resumed.runId).not.toBe(startup.runId)
    expect(compacted.runId).toBe(resumed.runId)
    expect(compacted.startSource).toBe("resume")
    expect(store.snapshotByTask()["task-1"]?.["tab-a"]?.runId).toBe(resumed.runId)
    expect(store.runsSnapshot()).toEqual([
      expect.objectContaining({ runId: startup.runId, state: "superseded", sessionId: "same-session" }),
      expect.objectContaining({ runId: resumed.runId, state: "bound", startSource: "resume" }),
    ])
  })

  it("lets SessionStart confirm an observed resume without creating a duplicate run", async () => {
    const { store } = await fixture()
    await store.begin("task-1", "tab-a", "codex")
    await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "old-session",
      source: "hook",
      eventKind: "session-start",
      startSource: "startup",
    })
    const observed = await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "resumed-session",
      source: "observer",
      startSource: "resume",
      transcriptPath: "/tmp/resumed.jsonl",
    })
    const confirmed = await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "resumed-session",
      source: "hook",
      eventKind: "session-start",
      startSource: "resume",
      transcriptPath: "/tmp/resumed.jsonl",
    })

    expect(confirmed.runId).toBe(observed.runId)
    expect(confirmed.source).toBe("hook")
    expect(store.runsSnapshot()).toHaveLength(2)

    const lateObserver = await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "resumed-session",
      source: "observer",
      startSource: "resume",
    })
    expect(lateObserver.runId).toBe(observed.runId)
    expect(lateObserver.source).toBe("hook")
  })

  it("keeps late events on a superseded session from stealing the current tab", async () => {
    const { store } = await fixture()
    await store.begin("task-1", "tab-a", "codex")
    const oldRun = await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "old-session",
      source: "hook",
      eventKind: "session-start",
      startSource: "startup",
    })
    const currentRun = await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "new-session",
      source: "hook",
      eventKind: "session-start",
      startSource: "startup",
    })
    const late = await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "old-session",
      source: "hook",
      eventKind: "turn-complete",
    })

    expect(late).toMatchObject({ runId: oldRun.runId, state: "superseded" })
    expect(store.snapshotByTask()["task-1"]?.["tab-a"]?.runId).toBe(currentRun.runId)
  })

  it("migrates the v1 overwrite binding into one current v2 run", async () => {
    const { path } = await fixture()
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            taskId: "task-1",
            tabId: "tab-a",
            vendor: "claude",
            sessionId: "legacy-session",
            state: "bound",
            source: "hook",
            startedAt: 10,
            boundAt: 11,
            updatedAt: 12,
          },
        ],
      }),
      "utf8",
    )
    const migrated = new SessionBindingStore(path, new DaemonEventBus())
    await migrated.init()

    expect(migrated.snapshotByTask()["task-1"]?.["tab-a"]).toMatchObject({
      runId: expect.any(String),
      sessionId: "legacy-session",
    })
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 2,
      runs: [expect.objectContaining({ sessionId: "legacy-session" })],
      currentRuns: [expect.objectContaining({ taskId: "task-1", tabId: "tab-a" })],
    })
  })

  it("removes all bindings when a task is hard-deleted", async () => {
    const { store } = await fixture()
    await store.begin("task-1", "tab-a", "codex")
    await store.begin("task-2", "tab-b", "claude")
    await store.deleteTask("task-1")
    expect(store.snapshotByTask()).toEqual({
      "task-2": {
        "tab-b": expect.objectContaining({ taskId: "task-2", tabId: "tab-b" }),
      },
    })
  })

  it("loads malformed files as an empty store", async () => {
    const { path } = await fixture()
    await writeFile(path, "{not json", "utf8")
    const store = new SessionBindingStore(path, new DaemonEventBus())
    await store.init()
    expect(store.snapshotByTask()).toEqual({})
  })
})
