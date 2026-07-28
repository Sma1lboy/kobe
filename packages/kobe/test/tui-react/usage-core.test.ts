import { describe, expect, it } from "vitest"
import { USAGE_BAR_WIDTH, formatReset, usageRows } from "../../src/tui-react/component/settings-dialog/usage-core.ts"
import { ratioBar } from "../../src/tui/lib/progress-bar.ts"

const NOW = Date.parse("2026-07-27T12:00:00.000Z")

describe("ratioBar", () => {
  it("renders empty, partial, and full meters at exactly the given width", () => {
    expect(ratioBar(0, 10)).toBe("░".repeat(10))
    expect(ratioBar(1, 10)).toBe("█".repeat(10))
    expect(ratioBar(0.5, 10)).toBe("█████░░░░░")
    for (const r of [0, 0.13, 0.5, 0.87, 1]) expect(ratioBar(r, 10)).toHaveLength(10)
  })

  it("clamps out-of-range ratios", () => {
    expect(ratioBar(-1, 8)).toBe("░".repeat(8))
    expect(ratioBar(2, 8)).toBe("█".repeat(8))
  })

  it("uses an eighth block for fractional cells", () => {
    expect(ratioBar(0.05, 10)).toBe(`▌${"░".repeat(9)}`)
  })
})

describe("formatReset", () => {
  it("shows clock only within 24h, day+clock beyond, empty when absent/past", () => {
    const in2h = NOW + 2 * 60 * 60 * 1000
    const in3d = NOW + 3 * 24 * 60 * 60 * 1000
    const clock = (ms: number) => {
      const d = new Date(ms)
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    }
    expect(formatReset(in2h, NOW)).toBe(`→ ${clock(in2h)}`)
    const d3 = new Date(in3d)
    expect(formatReset(in3d, NOW)).toBe(`→ ${d3.getMonth() + 1}/${d3.getDate()} ${clock(in3d)}`)
    expect(formatReset(null, NOW)).toBe("")
    expect(formatReset(NOW - 1000, NOW)).toBe("")
  })
})

describe("usageRows", () => {
  it("aligns labels, renders meters, and grades tones by utilization", () => {
    const rows = usageRows(
      {
        windows: [
          { kind: "session", label: "5h", percent: 43, resetsAt: NOW + 1000 * 60 },
          { kind: "weekly_all", label: "7d", percent: 80, resetsAt: null },
          { kind: "weekly_scoped", label: "Fable", percent: 100, resetsAt: NOW + 1000 * 60 },
        ],
        capturedAt: NOW,
      },
      NOW,
    )
    expect(rows.map((r) => r.label)).toEqual(["5h   ", "7d   ", "Fable"])
    expect(rows.map((r) => r.tone)).toEqual(["ok", "warn", "crit"])
    expect(rows.map((r) => r.percentText)).toEqual([" 43%", " 80%", "100%"])
    expect(rows[0]?.bar).toBe(ratioBar(0.43, USAGE_BAR_WIDTH))
    expect(rows[1]?.resetText).toBe("")
  })

  it("caps the label column so a long scoped model name cannot blow the layout", () => {
    const rows = usageRows(
      {
        windows: [{ kind: "weekly_scoped", label: "Extremely Long Model Name", percent: 10, resetsAt: null }],
        capturedAt: NOW,
      },
      NOW,
    )
    expect(rows[0]?.label).toBe("Extremel")
  })
})
