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
      transcriptPath: "/tmp/rollout.jsonl",
    })
    await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "019f-session",
      source: "hook",
      state: "ended",
    })

    const reloaded = new SessionBindingStore(path, new DaemonEventBus())
    await reloaded.init()
    expect(reloaded.snapshotByTask()["task-1"]?.["tab-a"]).toMatchObject({
      sessionId: "019f-session",
      state: "ended",
      source: "hook",
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
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 })
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

  it("keeps a bound identity when the same tab re-reads its engine spec", async () => {
    const { store } = await fixture()
    await store.begin("task-1", "tab-a", "codex")
    const bound = await store.bind({
      taskId: "task-1",
      tabId: "tab-a",
      vendor: "codex",
      sessionId: "existing",
      source: "hook",
    })

    expect(await store.begin("task-1", "tab-a", "codex")).toEqual(bound)
    expect(store.snapshotByTask()["task-1"]?.["tab-a"]).toEqual(bound)
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
