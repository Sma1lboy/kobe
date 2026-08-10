import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AttentionInboxStore } from "@sma1lboy/kobe-daemon/daemon/attention-inbox"
import { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import { afterEach, describe, expect, it } from "vitest"

describe("attention inbox store invariants", () => {
  let dir: string | null = null

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  it("stores and indexes a new episode under its required tab identity", async () => {
    dir = await mkdtemp(join(tmpdir(), "kobe-attention-inbox-invariants-"))
    const store = new AttentionInboxStore(join(dir, "attention-inbox.json"), new DaemonEventBus(), () => 100)
    await store.init()

    await store.record("task-1", "turn-complete", undefined, "tab-1")

    expect(store.snapshot()).toEqual([
      expect.objectContaining({ taskId: "task-1", tabId: "tab-1", state: "turn_complete", at: 100 }),
    ])
    expect(await store.markRead("task-1", "tab-1", 100)).toBe(true)
  })

  // A missing tab identity records at TASK level (owner call 2026-08-10 — an
  // engine typed into a bare shell inherits no KOBE_TAB_ID). An EMPTY string
  // is not a tab either: normalize it to null rather than keying an episode
  // on `""`.
  it("normalizes an empty tab identity to a task-level episode", async () => {
    dir = await mkdtemp(join(tmpdir(), "kobe-attention-inbox-invariants-"))
    const store = new AttentionInboxStore(join(dir, "attention-inbox.json"), new DaemonEventBus())
    await store.init()

    await store.record("task-1", "turn-complete", undefined, "")
    expect(store.snapshot().map((episode) => episode.tabId)).toEqual([null])

    // The same task's tab-level episode is a DIFFERENT queue entry.
    await store.record("task-1", "turn-complete", undefined, "tab-1")
    expect(new Set(store.snapshot().map((episode) => episode.tabId))).toEqual(new Set([null, "tab-1"]))
  })

  it("does not delete a replacement episode through a stale dismiss action", async () => {
    let now = 100
    dir = await mkdtemp(join(tmpdir(), "kobe-attention-inbox-invariants-"))
    const store = new AttentionInboxStore(join(dir, "attention-inbox.json"), new DaemonEventBus(), () => now)
    await store.init()
    await store.record("task-1", "turn-complete", undefined, "tab-1")

    now = 200
    await store.record("task-1", "turn-failed", { failure: "other" }, "tab-1")

    expect(await store.deleteEpisode("task-1", "tab-1", 100)).toBe(false)
    expect(store.snapshot()).toEqual([expect.objectContaining({ taskId: "task-1", tabId: "tab-1", at: 200 })])
    expect(await store.deleteEpisode("task-1", "tab-1", 200)).toBe(true)
  })
})
