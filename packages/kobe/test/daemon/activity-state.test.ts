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
})
