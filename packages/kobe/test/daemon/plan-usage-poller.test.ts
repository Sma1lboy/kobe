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
