import { describe, expect, it } from "vitest"
import { formatPlanUsageCompact } from "../../src/tui/lib/format-plan-usage.ts"
import type { PlanUsage } from "../../src/types/plan-usage.ts"

const baseSnapshot: PlanUsage = {
  fiveHour: { utilization: 42, resetsAt: null },
  sevenDay: { utilization: 18, resetsAt: null },
  sevenDayOpus: null,
  sevenDaySonnet: null,
  fetchedAt: "2026-05-10T00:00:00.000Z",
}

describe("formatPlanUsageCompact", () => {
  it("returns null on missing snapshot", () => {
    expect(formatPlanUsageCompact(null)).toBe(null)
  })

  it("joins 5h + 7d when both present", () => {
    expect(formatPlanUsageCompact(baseSnapshot)).toBe("Plan 5h 42% · 7d 18%")
  })

  it("rounds fractional percentages to whole numbers", () => {
    expect(
      formatPlanUsageCompact({
        ...baseSnapshot,
        fiveHour: { utilization: 42.6, resetsAt: null },
        sevenDay: { utilization: 17.4, resetsAt: null },
      }),
    ).toBe("Plan 5h 43% · 7d 17%")
  })

  it("emits only the present half when one bucket is null", () => {
    expect(formatPlanUsageCompact({ ...baseSnapshot, sevenDay: null })).toBe("Plan 5h 42%")
    expect(formatPlanUsageCompact({ ...baseSnapshot, fiveHour: null })).toBe("Plan 7d 18%")
  })

  it("returns null when neither bucket has a utilization number", () => {
    expect(
      formatPlanUsageCompact({
        ...baseSnapshot,
        fiveHour: { utilization: null, resetsAt: null },
        sevenDay: { utilization: null, resetsAt: null },
      }),
    ).toBe(null)
  })
})
