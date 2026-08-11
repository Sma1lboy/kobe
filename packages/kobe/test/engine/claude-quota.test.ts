import { userInfo } from "node:os"
import { describe, expect, it, vi } from "vitest"
import { parseResetsAtMs, usageFromClaudePayload } from "../../src/engine/claude-code-local/quota.ts"

const spawnCapture = vi.hoisted(() => vi.fn())
vi.mock("../../src/lib/poll-scheduling.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/poll-scheduling.ts")>()),
  spawnCapture,
}))

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

describe("fetchClaudeQuotaUsage keychain lookup", () => {
  // The owner's machine carried TWO items under this service name: a stale
  // `acct=unknown` row and today's login. Looking the item up by service
  // alone returned the stale one, so the dashboard stayed empty through
  // repeated re-logins. Pin the account flag the CLI itself passes.
  // darwin-only: the lookup bails before spawning `security` elsewhere,
  // so on Linux CI the spy records no call and the assertions have no
  // subject (v0.8.66 publish gate failure).
  it.runIf(process.platform === "darwin")("queries the keychain by account as well as service", async () => {
    spawnCapture.mockResolvedValue({ status: 1, stdout: "", stderr: "" })
    const { fetchClaudeQuotaUsage } = await import("../../src/engine/claude-code-local/quota.ts")

    expect(await fetchClaudeQuotaUsage()).toBeNull()

    const args = spawnCapture.mock.calls[0]?.[1] as string[]
    expect(args).toContain("-a")
    expect(args[args.indexOf("-a") + 1]).toBe(userInfo().username)
    expect(args[args.indexOf("-s") + 1]).toBe("Claude Code-credentials")
  })
})
