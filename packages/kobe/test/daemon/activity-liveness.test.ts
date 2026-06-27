import {
  type ActivityLivenessProbe,
  DaemonActivityRegistry,
  type EngineStatePayload,
} from "@sma1lboy/kobe-daemon/daemon/activity-registry"
import { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TaskActivityState } from "../../src/engine/hook-events.ts"

const TTL = 1_000

/**
 * Liveness watchdog (KOB-bug: a still-running task flips to idle after ~10min).
 *
 * A long single agent turn emits only `turn-start` … `Stop` over many minutes
 * with NO hook events in between, so the fixed lapse timer used to fire
 * mid-turn and wrongly idle a working agent. The fix probes the engine's
 * transcript mtime when the timer fires: a write within the trailing staleness
 * window means the turn is alive (re-arm instead of idling); a genuinely
 * silent engine (missed Stop / hung process) still lapses to idle. These tests
 * drive that with a FAKE clock + FAKE probe — no real filesystem.
 */
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
    // Probe always reports "written just now" ⇒ alive every window.
    const probe: ActivityLivenessProbe = vi.fn(() => Promise.resolve(Date.now()))
    registry = new DaemonActivityRegistry(bus, TTL, () => Date.now(), probe)

    registry.report("t", "turn-start")
    expect(states.t).toEqual(["running"])

    // Cross three full TTL windows — a fixed timer would have idled at the
    // first; the heartbeat keeps it running.
    await vi.advanceTimersByTimeAsync(TTL)
    await vi.advanceTimersByTimeAsync(TTL)
    await vi.advanceTimersByTimeAsync(TTL)

    expect(states.t).toEqual(["running"])
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it("lapses to idle when the transcript has not advanced within the window", async () => {
    // Probe reports an mtime stuck at the report instant (epoch 0) — outside
    // the trailing window once the timer fires at TTL.
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
    // First window: alive ⇒ rescheduled. Exactly one pending timer remains.
    await vi.advanceTimersByTimeAsync(TTL)
    expect(vi.getTimerCount()).toBe(1)

    // A fresh event must clear the rescheduled timer and arm a new one — never
    // leak a second timer.
    registry.report("t", "turn-start")
    expect(vi.getTimerCount()).toBe(1)

    // Now go silent: only the post-report timer should fire and idle once.
    // (The second report re-publishes "running"; the reschedule itself never
    // publishes, so the lone "idle" proves no leaked timer double-idled.)
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
    await vi.advanceTimersByTimeAsync(TTL) // timer fires, probe is now in flight
    registry.clearTask("t") // supersedes the in-flight lapse
    resolveProbe?.(0) // would lapse, but the entry is gone
    await Promise.resolve()
    await Promise.resolve()

    // clearTask published idle; the resolved probe must NOT publish a second.
    expect(states.t).toEqual(["running", "idle"])
  })
})
