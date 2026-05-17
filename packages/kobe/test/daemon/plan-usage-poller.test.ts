import { describe, expect, it } from "vitest"
import { createPlanUsagePoller } from "../../src/daemon/plan-usage-poller.ts"
import type { PlanUsage } from "../../src/types/plan-usage.ts"

const snapshot = (utilization: number): PlanUsage => ({
  fiveHour: { utilization, resetsAt: null },
  sevenDay: { utilization: utilization / 2, resetsAt: null },
  sevenDayOpus: null,
  sevenDaySonnet: null,
  fetchedAt: new Date().toISOString(),
})

describe("plan-usage-poller", () => {
  it("publishes the first snapshot before the interval fires", async () => {
    const seen: PlanUsage[] = []
    const poller = createPlanUsagePoller({
      intervalMs: 60_000,
      fetcher: async () => snapshot(11),
      onUpdate: (u) => seen.push(u),
    })
    poller.start()
    // start() kicks off an immediate tick; wait a microtask cycle.
    await new Promise((r) => setTimeout(r, 5))
    poller.stop()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.fiveHour?.utilization).toBe(11)
    expect(poller.current()?.fiveHour?.utilization).toBe(11)
  })

  it("silently swallows null fetch results without updating subscribers", async () => {
    const seen: PlanUsage[] = []
    const poller = createPlanUsagePoller({
      intervalMs: 60_000,
      fetcher: async () => null,
      onUpdate: (u) => seen.push(u),
    })
    poller.start()
    await new Promise((r) => setTimeout(r, 5))
    poller.stop()
    expect(seen).toEqual([])
    expect(poller.current()).toBe(null)
  })

  it("survives a rejecting fetcher — refresh resolves, last snapshot kept", async () => {
    // Regression: `tick()` had no catch, so a rejecting `fetcher`
    // (network / token-read failure on the real poller) escaped
    // `void tick()` as an unhandled rejection and killed the daemon.
    // It must now swallow + log instead.
    const seen: PlanUsage[] = []
    let calls = 0
    const poller = createPlanUsagePoller({
      intervalMs: 60_000,
      fetcher: async () => {
        calls++
        if (calls === 2) throw new Error("network down")
        return snapshot(7)
      },
      onUpdate: (u) => seen.push(u),
    })
    await poller.refresh() // ok → snapshot(7)
    await expect(poller.refresh()).resolves.toBeUndefined() // rejects internally, must not throw
    expect(poller.current()?.fiveHour?.utilization).toBe(7) // last good snapshot retained
    expect(seen).toHaveLength(1)
  })

  it("does not overlap in-flight ticks", async () => {
    let inFlight = 0
    let maxConcurrent = 0
    const poller = createPlanUsagePoller({
      intervalMs: 60_000,
      fetcher: async () => {
        inFlight++
        maxConcurrent = Math.max(maxConcurrent, inFlight)
        await new Promise((r) => setTimeout(r, 30))
        inFlight--
        return snapshot(1)
      },
      onUpdate: () => {},
    })
    poller.start()
    void poller.refresh()
    void poller.refresh()
    await new Promise((r) => setTimeout(r, 80))
    poller.stop()
    expect(maxConcurrent).toBe(1)
  })
})
