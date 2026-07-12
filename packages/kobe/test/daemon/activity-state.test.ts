import { DaemonActivityRegistry } from "@sma1lboy/kobe-daemon/daemon/activity-registry"
import { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import { afterEach, describe, expect, it } from "vitest"
import type { TaskActivityState } from "../../src/engine/hook-events.ts"
import { type DaemonHarness, bootDaemonHarness } from "./harness.ts"

const TTL_MS = 30

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("daemon activity state", () => {
  let h: DaemonHarness | null = null

  afterEach(async () => {
    await h?.close()
    h = null
  })

  it("keeps turn-complete visible instead of lapsing it back to idle", async () => {
    h = await bootDaemonHarness({ env: { KOBE_ENGINE_STATE_TTL_MS: String(TTL_MS) } })
    const client = h.client()
    const states: TaskActivityState[] = []
    client.onChannel("engine-state", (payload) => {
      if (payload.taskId === "task-1") states.push(payload.state)
    })
    await client.subscribe()

    await client.request("engine.reportEvent", { taskId: "task-1", kind: "turn-complete" })
    await sleep(TTL_MS + 50)

    expect(states).toEqual(["turn_complete"])
    client.close()
  })

  it("keeps permission_needed sticky instead of lapsing it to idle after the TTL", async () => {
    // The whole point of the ? badge: a task blocked on a permission prompt is
    // exactly what a user leaves the session to handle. A blocked engine writes
    // no transcript, so the liveness probe reads "stale" — the badge must NOT
    // lapse to idle regardless, or "come back and see who's stuck" breaks.
    h = await bootDaemonHarness({ env: { KOBE_ENGINE_STATE_TTL_MS: String(TTL_MS) } })
    const client = h.client()
    const states: TaskActivityState[] = []
    client.onChannel("engine-state", (payload) => {
      if (payload.taskId === "task-1") states.push(payload.state)
    })
    await client.subscribe()

    await client.request("engine.reportEvent", {
      taskId: "task-1",
      kind: "awaiting-input",
      detail: { waiting: "permission" },
    })
    await sleep(TTL_MS + 50)

    expect(states).toEqual(["permission_needed"])
    client.close()
  })

  it("keeps error / rate_limited sticky — no lapse timer armed for either", () => {
    // Even with a probe that always reports "dead" (mtime 0), a blocked/errored
    // engine must stay lit. These states arm no lapse at all, so no timer exists
    // to fire; the badge clears only on the next real event / clearTask.
    const bus = new DaemonEventBus()
    const registry = new DaemonActivityRegistry(
      bus,
      TTL_MS,
      () => Date.now(),
      () => Promise.resolve(0),
    )

    registry.report("task-err", "turn-failed", { failure: "other" })
    registry.report("task-rl", "turn-failed", { failure: "rate_limit" })

    expect(registry.currentNonIdle().map((p) => [p.taskId, p.state])).toEqual([
      ["task-err", "error"],
      ["task-rl", "rate_limited"],
    ])
    registry.close()
  })

  it("replays every current non-idle activity, not just the bus cache", () => {
    const bus = new DaemonEventBus()
    const registry = new DaemonActivityRegistry(bus, 1_000)

    registry.report("task-1", "turn-start")
    registry.report("task-2", "awaiting-input", { waiting: "permission" })

    expect(registry.currentNonIdle().map((p) => [p.taskId, p.state])).toEqual([
      ["task-1", "running"],
      ["task-2", "permission_needed"],
    ])
    expect(bus.snapshot().filter((event) => event.channel === "engine-state")).toHaveLength(1)

    registry.close()
  })

  // Why: the F7 attention jump's tab precision rides these — a tabId-carrying
  // report must ledger per-tab (published + replayed with the tabId), the
  // task-level rollup must stay identical for every existing consumer, and a
  // question dialog (`awaiting-input` waiting:"input") is now a blocking
  // attention state, not `running` (owner call 2026-07-12).
  it("tracks tabId-carrying reports per tab: publish, replay, session-end + clearTask cleanup", () => {
    const bus = new DaemonEventBus()
    const registry = new DaemonActivityRegistry(bus, 1_000)
    const published: Array<{ taskId: string; tabId?: string; state: string }> = []
    bus.onPublish((event) => {
      if (event.channel === "engine-state") {
        const p = event.payload as { taskId: string; tabId?: string; state: string }
        published.push({ taskId: p.taskId, tabId: p.tabId, state: p.state })
      }
    })

    registry.report("task-1", "awaiting-input", { waiting: "input" }, "tab-2")
    expect(published).toEqual([{ taskId: "task-1", tabId: "tab-2", state: "permission_needed" }])
    // Replay carries the task rollup AND the tab entry.
    expect(registry.currentNonIdle().map((p) => [p.taskId, p.tabId, p.state])).toEqual([
      ["task-1", undefined, "permission_needed"],
      ["task-1", "tab-2", "permission_needed"],
    ])

    // A tab's session-end drops its per-tab entry (idle is never stored).
    registry.report("task-1", "session-end", undefined, "tab-2")
    expect(registry.currentNonIdle()).toEqual([])

    // clearTask publishes per-tab idles so subscribers drop tab candidates.
    registry.report("task-1", "turn-complete", undefined, "tab-3")
    published.length = 0
    registry.clearTask("task-1")
    expect(published).toEqual([
      { taskId: "task-1", tabId: "tab-3", state: "idle" },
      { taskId: "task-1", tabId: undefined, state: "idle" },
    ])

    registry.close()
  })
})
