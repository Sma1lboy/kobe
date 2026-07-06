import {
  type ActivityLivenessProbe,
  DaemonActivityRegistry,
  type EngineStatePayload,
} from "@sma1lboy/kobe-daemon/daemon/activity-registry"
import { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TaskActivityState } from "../../src/engine/hook-events.ts"

const TTL = 1_000

describe("activity registry liveness watchdog", () => {
  let bus: DaemonEventBus
  let states: Record<string, TaskActivityState[]>
  let registry: DaemonActivityRegistry | null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    bus = new DaemonEventBus()
    states = {}
    bus.onPublish((event) => {
      if (event.channel !== "engine-state") return
      const payload = event.payload as EngineStatePayload
      const seen = states[payload.taskId] ?? []
      seen.push(payload.state)
      states[payload.taskId] = seen
    })
    registry = null
  })

  afterEach(() => {
    registry?.close()
    vi.useRealTimers()
  })

  it("re-arms (does not idle) a running turn whose transcript keeps advancing", async () => {
    const probe: ActivityLivenessProbe = vi.fn(() => Promise.resolve(Date.now()))
    registry = new DaemonActivityRegistry(bus, TTL, () => Date.now(), probe)

    registry.report("t", "turn-start")
    expect(states.t).toEqual(["running"])

    await vi.advanceTimersByTimeAsync(TTL)
    await vi.advanceTimersByTimeAsync(TTL)
    await vi.advanceTimersByTimeAsync(TTL)

    expect(states.t).toEqual(["running"])
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it("lapses to idle when the transcript has not advanced within the window", async () => {
    const probe: ActivityLivenessProbe = vi.fn(() => Promise.resolve(0))
    registry = new DaemonActivityRegistry(bus, TTL, () => Date.now(), probe)

    registry.report("t", "turn-start")
    await vi.advanceTimersByTimeAsync(TTL)

    expect(states.t).toEqual(["running", "idle"])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it("cancels a pending rescheduled lapse when a later report arrives", async () => {
    let alive = true
    const probe: ActivityLivenessProbe = vi.fn(() => Promise.resolve(alive ? Date.now() : 0))
    registry = new DaemonActivityRegistry(bus, TTL, () => Date.now(), probe)

    registry.report("t", "turn-start")
    await vi.advanceTimersByTimeAsync(TTL)
    expect(vi.getTimerCount()).toBe(1)

    registry.report("t", "turn-start")
    expect(vi.getTimerCount()).toBe(1)

    alive = false
    await vi.advanceTimersByTimeAsync(TTL)
    expect(states.t).toEqual(["running", "running", "idle"])
  })

  it("falls back to lapsing when the probe throws (no crash)", async () => {
    const probe: ActivityLivenessProbe = vi.fn(() => Promise.reject(new Error("fs boom")))
    registry = new DaemonActivityRegistry(bus, TTL, () => Date.now(), probe)

    registry.report("t", "turn-start")
    await vi.advanceTimersByTimeAsync(TTL)

    expect(states.t).toEqual(["running", "idle"])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it("never idles after the entry was cleared during the probe await", async () => {
    let resolveProbe: ((v: number) => void) | undefined
    const probe: ActivityLivenessProbe = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveProbe = resolve
        }),
    )
    registry = new DaemonActivityRegistry(bus, TTL, () => Date.now(), probe)

    registry.report("t", "turn-start")
    await vi.advanceTimersByTimeAsync(TTL)
    registry.clearTask("t")
    resolveProbe?.(0)
    await Promise.resolve()
    await Promise.resolve()

    expect(states.t).toEqual(["running", "idle"])
  })
})
