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

  /**
   * Per-tab watchdog (turn-state consolidation): the tab strip's chip now
   * keys off the hook-driven per-tab `running`, so a missed Stop pinning a
   * tab entry would pin the ● indefinitely. The tab entry gets its own
   * probe-then-idle heartbeat; on lapse the daemon publishes a per-tab idle
   * so hook-wins subscribers fall back to the quiescence poll.
   */
  it("lapses a silent per-tab entry and publishes a tabId-scoped idle", async () => {
    const probe: ActivityLivenessProbe = vi.fn(() => Promise.resolve(0))
    registry = new DaemonActivityRegistry(bus, TTL, () => Date.now(), probe)
    const tabEvents: { tabId?: string; state: TaskActivityState }[] = []
    bus.onPublish((event) => {
      if (event.channel !== "engine-state") return
      const payload = event.payload as EngineStatePayload & { tabId?: string }
      if (payload.tabId) tabEvents.push({ tabId: payload.tabId, state: payload.state })
    })

    registry.report("t", "turn-start", undefined, "tab-1")
    await vi.advanceTimersByTimeAsync(TTL)

    expect(tabEvents).toEqual([
      { tabId: "tab-1", state: "running" },
      { tabId: "tab-1", state: "idle" },
    ])
    // The lapsed tab entry must not linger in the replay set.
    expect(registry.currentNonIdle().filter((p) => "tabId" in p && p.tabId)).toEqual([])
  })

  it("keeps an alive per-tab running entry lit across windows (heartbeat)", async () => {
    const probe: ActivityLivenessProbe = vi.fn(() => Promise.resolve(Date.now()))
    registry = new DaemonActivityRegistry(bus, TTL, () => Date.now(), probe)

    registry.report("t", "turn-start", undefined, "tab-1")
    await vi.advanceTimersByTimeAsync(TTL)
    await vi.advanceTimersByTimeAsync(TTL)

    const tabs = registry.currentNonIdle().filter((p) => "tabId" in p && p.tabId)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.state).toBe("running")
  })

  it("sticky per-tab states (turn_complete) never lapse", async () => {
    const probe: ActivityLivenessProbe = vi.fn(() => Promise.resolve(0))
    registry = new DaemonActivityRegistry(bus, TTL, () => Date.now(), probe)

    registry.report("t", "turn-complete", undefined, "tab-1")
    await vi.advanceTimersByTimeAsync(TTL * 3)

    const tabs = registry.currentNonIdle().filter((p) => "tabId" in p && p.tabId)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.state).toBe("turn_complete")
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
