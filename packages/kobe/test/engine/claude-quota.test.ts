import { describe, expect, it } from "vitest"
import { parseResetsAtMs, quotaResetAtMs } from "../../src/engine/claude-code-local/quota.ts"

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

describe("quotaResetAtMs", () => {
  it("returns the earliest future reset among EXHAUSTED limits only", () => {
    const at = quotaResetAtMs(
      {
        limits: [
          // Allowed window: its resets_at is rolling-window metadata, not a limit hit.
          { kind: "session", percent: 40, resets_at: (NOW + 1000) / 1000 },
          { kind: "weekly_all", percent: 100, resets_at: IN_5H / 1000 },
          { kind: "weekly_scoped", percent: 100, resets_at: IN_1H / 1000 },
        ],
      },
      NOW,
    )
    expect(at).toBe(IN_1H)
  })

  it("returns null when nothing is exhausted", () => {
    expect(quotaResetAtMs({ limits: [{ kind: "session", percent: 99, resets_at: IN_1H / 1000 }] }, NOW)).toBeNull()
  })

  it("ignores exhausted limits whose reset is missing or already past", () => {
    expect(
      quotaResetAtMs(
        {
          limits: [
            { kind: "session", percent: 100, resets_at: null },
            { kind: "weekly_all", percent: 100, resets_at: (NOW - 1000) / 1000 },
          ],
        },
        NOW,
      ),
    ).toBeNull()
  })

  it("falls back to legacy five_hour/seven_day windows when limits[] is absent", () => {
    const at = quotaResetAtMs(
      {
        five_hour: { utilization: 100, resets_at: IN_1H / 1000 },
        seven_day: { utilization: 60, resets_at: IN_5H / 1000 },
      },
      NOW,
    )
    expect(at).toBe(IN_1H)
  })

  it("returns null for an empty payload", () => {
    expect(quotaResetAtMs({}, NOW)).toBeNull()
  })
})
