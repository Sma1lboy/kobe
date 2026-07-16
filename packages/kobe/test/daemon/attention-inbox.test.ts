import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AttentionInboxStore } from "@sma1lboy/kobe-daemon/daemon/attention-inbox"
import { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import { afterEach, describe, expect, it } from "vitest"

describe("daemon attention inbox", () => {
  let dir: string | null = null

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  async function create(now: number | (() => number) = 100): Promise<{
    store: AttentionInboxStore
    path: string
    bus: DaemonEventBus
  }> {
    dir = await mkdtemp(join(tmpdir(), "kobe-attention-inbox-"))
    const path = join(dir, "attention-inbox.json")
    const bus = new DaemonEventBus()
    const store = new AttentionInboxStore(path, bus, () => (typeof now === "function" ? now() : now))
    await store.init()
    return { store, path, bus }
  }

  it("persists attention episodes and replays the full snapshot", async () => {
    const { store, path, bus } = await create(123)
    const snapshots: unknown[] = []
    bus.onPublish((event) => {
      if (event.channel === "attention.inbox") snapshots.push(event.payload)
    })

    await store.record("task-1", "turn-complete", undefined, "tab-2")

    expect(store.snapshot()).toEqual([
      { taskId: "task-1", tabId: "tab-2", state: "turn_complete", unread: true, at: 123 },
    ])
    expect(snapshots.at(-1)).toEqual({ items: store.snapshot() })
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, items: store.snapshot() })

    const reloaded = new AttentionInboxStore(path, new DaemonEventBus(), () => 999)
    await reloaded.init()
    expect(reloaded.snapshot()).toEqual(store.snapshot())
  })

  it("removes only on a newer turn-start for the same task and tab", async () => {
    const { store } = await create()
    await store.record("task-1", "awaiting-input", { waiting: "permission" }, "tab-1")

    await store.record("task-1", "session-end", undefined, "tab-1")
    await store.record("task-1", "turn-start", undefined, "tab-2")
    expect(store.snapshot()).toHaveLength(1)

    await store.record("task-1", "turn-start", undefined, "tab-1")
    expect(store.snapshot()).toEqual([])
  })

  it("manual deletion dismisses one episode but a later episode returns", async () => {
    const { store } = await create()
    await store.record("task-1", "turn-failed", { failure: "other", note: "boom" }, "tab-1")

    expect(await store.deleteEpisode("task-1", "tab-1")).toBe(true)
    expect(store.snapshot()).toEqual([])
    expect(await store.deleteEpisode("task-1", "tab-1")).toBe(false)

    await store.record("task-1", "turn-complete", undefined, "tab-1")
    expect(store.snapshot()).toEqual([
      { taskId: "task-1", tabId: "tab-1", state: "turn_complete", unread: true, at: 100 },
    ])
  })

  it("resolves an episode on open and ignores a stale open after a replacement", async () => {
    // Queue-drain model (owner 2026-07-16): opening REMOVES the episode
    // (markRead is a legacy alias for delete); a fresh event re-records at
    // the latest position, and a stale open (old `at`) must not eat it.
    let now = 100
    const { store, path } = await create(() => now)
    await store.record("task-1", "turn-complete", undefined, "tab-1")

    expect(await store.markRead("task-1", "tab-1", 100)).toBe(true)
    expect(store.snapshot()).toHaveLength(0)

    now = 200
    await store.record("task-1", "turn-failed", { failure: "other" }, "tab-1")
    expect(await store.markRead("task-1", "tab-1", 100)).toBe(false)
    expect(store.snapshot()[0]).toMatchObject({ at: 200 })

    const reloaded = new AttentionInboxStore(path, new DaemonEventBus())
    await reloaded.init()
    expect(reloaded.snapshot()[0]).toMatchObject({ at: 200 })
  })

  it("replaces a stale episode with the fresh one at the latest position", async () => {
    let now = 100
    const { store } = await create(() => now)
    await store.record("task-1", "turn-complete", undefined, "tab-1")
    now = 150
    await store.record("task-2", "turn-complete", undefined, "tab-1")

    // A fresh event on task-1/tab-1 replaces the old episode — dedupe keeps
    // ONE pending entry per task+tab and re-stamps it to the queue tail.
    now = 200
    await store.record("task-1", "awaiting-input", { waiting: "permission" }, "tab-1")
    const snapshot = store.snapshot()
    expect(snapshot).toHaveLength(2)
    expect(snapshot.map((item) => [item.taskId, item.at])).toEqual([
      ["task-2", 150],
      ["task-1", 200],
    ])
    expect(snapshot[1]).toMatchObject({ state: "permission_needed" })
  })

  it("treats pre-unread snapshots as unread", async () => {
    dir = await mkdtemp(join(tmpdir(), "kobe-attention-inbox-legacy-"))
    const path = join(dir, "attention-inbox.json")
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        items: [{ taskId: "task-1", tabId: null, state: "turn_complete", at: 50 }],
      }),
      "utf8",
    )
    const store = new AttentionInboxStore(path, new DaemonEventBus())
    await store.init()
    expect(store.snapshot()[0]?.unread).toBe(true)
  })

  it("keeps closed-tab episodes but cascades an explicit task deletion", async () => {
    const { store } = await create()
    await store.record("task-1", "turn-complete", undefined, "tab-1")
    await store.record("task-1", "session-end", undefined, "tab-1")
    await store.record("task-2", "turn-complete", undefined, "tab-1")

    await store.deleteTask("task-1")

    expect(store.snapshot().map((item) => item.taskId)).toEqual(["task-2"])
  })

  it("classifies waiting, rate limits, billing failures, and other failures", async () => {
    const { store } = await create()
    await store.record("task-1", "awaiting-input", { waiting: "input" }, "tab-1")
    await store.record("task-1", "turn-failed", { failure: "rate_limit" }, "tab-2")
    await store.record("task-1", "turn-failed", { failure: "billing" }, "tab-3")
    await store.record("task-1", "turn-failed", { failure: "other" }, "tab-4")

    expect(Object.fromEntries(store.snapshot().map((item) => [item.tabId, item.state]))).toEqual({
      "tab-1": "permission_needed",
      "tab-2": "rate_limited",
      "tab-3": "error",
      "tab-4": "error",
    })
  })

  it("boots with an empty Inbox when the persisted JSON is corrupt", async () => {
    dir = await mkdtemp(join(tmpdir(), "kobe-attention-inbox-corrupt-"))
    const path = join(dir, "attention-inbox.json")
    await writeFile(path, "{not-json", "utf8")
    const bus = new DaemonEventBus()
    const store = new AttentionInboxStore(path, bus)

    await expect(store.init()).resolves.toBeUndefined()
    expect(store.snapshot()).toEqual([])
    expect(bus.snapshot()).toContainEqual({ channel: "attention.inbox", payload: { items: [] } })
  })

  it("keeps memory unchanged when an atomic write fails", async () => {
    dir = await mkdtemp(join(tmpdir(), "kobe-attention-inbox-blocked-"))
    const blocker = join(dir, "not-a-directory")
    await writeFile(blocker, "blocked", "utf8")
    const store = new AttentionInboxStore(join(blocker, "attention-inbox.json"), new DaemonEventBus())
    await store.init()

    await expect(store.record("task-1", "turn-complete", undefined, "tab-1")).rejects.toThrow()
    expect(store.snapshot()).toEqual([])
  })

  it("keeps task deletion live when Inbox cleanup fails", async () => {
    const { store } = await create()
    store.deleteTask = async () => {
      throw new Error("disk full")
    }

    await expect(store.deleteTaskBestEffort("task-1")).resolves.toBeUndefined()
  })
})
