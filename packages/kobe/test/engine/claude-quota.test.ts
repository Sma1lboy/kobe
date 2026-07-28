import { describe, expect, it } from "vitest"
import { parseResetsAtMs, usageFromClaudePayload } from "../../src/engine/claude-code-local/quota.ts"

const NOW = Date.parse("2026-07-27T12:00:00.000Z")
const IN_1H = NOW + 60 * 60 * 1000
const IN_5H = NOW + 5 * 60 * 60 * 1000

describe("parseResetsAtMs", () => {
  it("parses epoch seconds, epoch ms, quoted epochs, and ISO strings", () => {
    expect(parseResetsAtMs(1784613216)).toBe(1784613216000)
    expect(parseResetsAtMs(1784613216000)).toBe(1784613216000)
    expect(parseResetsAtMs("1784613216")).toBe(1784613216000)
    expect(parseResetsAtMs("2026-07-27T13:00:00.000Z")).toBe(Date.parse("2026-07-27T13:00:00.000Z"))
  })

  it("rejects null, garbage, and non-positive values", () => {
    expect(parseResetsAtMs(null)).toBeNull()
    expect(parseResetsAtMs(undefined)).toBeNull()
    expect(parseResetsAtMs("soon")).toBeNull()
    expect(parseResetsAtMs(0)).toBeNull()
    expect(parseResetsAtMs(-5)).toBeNull()
  })
})

describe("usageFromClaudePayload", () => {
  it("maps limits[] rows to neutral windows with display labels", () => {
    const usage = usageFromClaudePayload(
      {
        limits: [
          { kind: "session", percent: 43.4, resets_at: IN_1H / 1000 },
          { kind: "weekly_all", percent: 27, resets_at: IN_5H / 1000 },
          { kind: "weekly_scoped", percent: 12, resets_at: IN_5H / 1000, scope: { model: { display_name: "Fable" } } },
        ],
      },
      NOW,
    )
    expect(usage.capturedAt).toBe(NOW)
    expect(usage.windows).toEqual([
      { kind: "session", label: "5h", percent: 43, resetsAt: IN_1H },
      { kind: "weekly_all", label: "7d", percent: 27, resetsAt: IN_5H },
      { kind: "weekly_scoped", label: "Fable", percent: 12, resetsAt: IN_5H },
    ])
  })

  it("skips malformed rows and clamps percent into 0..100", () => {
    const usage = usageFromClaudePayload(
      { limits: [{ kind: "session", percent: 140, resets_at: null }, { percent: 50 }, { kind: "weekly_all" }] },
      NOW,
    )
    expect(usage.windows).toEqual([{ kind: "session", label: "5h", percent: 100, resetsAt: null }])
  })

  it("falls back to legacy five_hour/seven_day windows when limits[] is absent", () => {
    const usage = usageFromClaudePayload(
      {
        five_hour: { utilization: 88.6, resets_at: IN_1H / 1000 },
        seven_day: { utilization: 60, resets_at: IN_5H / 1000 },
      },
      NOW,
    )
    expect(usage.windows).toEqual([
      { kind: "session", label: "5h", percent: 89, resetsAt: IN_1H },
      { kind: "weekly_all", label: "7d", percent: 60, resetsAt: IN_5H },
    ])
  })

  it("returns an empty window list for an empty payload", () => {
    expect(usageFromClaudePayload({}, NOW).windows).toEqual([])
  })
})
