import { mkdtemp, readFile, rm } from "node:fs/promises"
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

  async function create(now = 100): Promise<{ store: AttentionInboxStore; path: string; bus: DaemonEventBus }> {
    dir = await mkdtemp(join(tmpdir(), "kobe-attention-inbox-"))
    const path = join(dir, "attention-inbox.json")
    const bus = new DaemonEventBus()
    const store = new AttentionInboxStore(path, bus, () => now)
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

    expect(store.snapshot()).toEqual([{ taskId: "task-1", tabId: "tab-2", state: "turn_complete", at: 123 }])
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
    expect(store.snapshot()).toEqual([{ taskId: "task-1", tabId: "tab-1", state: "turn_complete", at: 100 }])
  })

  it("keeps closed-tab episodes but cascades an explicit task deletion", async () => {
    const { store } = await create()
    await store.record("task-1", "turn-complete", undefined, "tab-1")
    await store.record("task-1", "session-end", undefined, "tab-1")
    await store.record("task-2", "turn-complete", undefined, "tab-1")

    await store.deleteTask("task-1")

    expect(store.snapshot().map((item) => item.taskId)).toEqual(["task-2"])
  })
})
