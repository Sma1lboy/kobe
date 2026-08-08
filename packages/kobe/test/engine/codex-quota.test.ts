// `vitest`, not `bun:test`: only `test/render/**` runs under the Bun runner
// (it needs OpenTUI's native renderer); everything else — including this
// directory — is loaded by vitest, which can't resolve `bun:test` at all and
// fails the whole FILE rather than a single assertion.
import { describe, expect, it } from "vitest"
import { usageFromRolloutRaw } from "../../src/engine/codex-local/quota.ts"

const NOW = 1_786_000_000_000
/** Epoch SECONDS, one hour ahead of NOW — the shape Codex writes. */
const LIVE_RESET = Math.floor(NOW / 1000) + 3600

const line = (limits: unknown): string => JSON.stringify({ type: "event_msg", payload: { rate_limits: limits } })

describe("usageFromRolloutRaw", () => {
  it("reads the LAST rate_limits block and normalizes both windows", () => {
    const raw = [
      line({ primary: { used_percent: 5, window_minutes: 300, resets_at: LIVE_RESET } }),
      '{"type":"response_item","payload":{}}',
      line({
        primary: { used_percent: 46.6, window_minutes: 300, resets_at: LIVE_RESET },
        secondary: { used_percent: 12, window_minutes: 10080, resets_at: LIVE_RESET },
      }),
    ].join("\n")

    expect(usageFromRolloutRaw(raw, NOW)).toEqual({
      capturedAt: NOW,
      windows: [
        { kind: "primary", label: "5h", percent: 47, resetsAt: LIVE_RESET * 1000 },
        { kind: "secondary", label: "7d", percent: 12, resetsAt: LIVE_RESET * 1000 },
      ],
    })
  })

  it("drops already-reset windows — a stale reading is not current usage", () => {
    const stale = Math.floor(NOW / 1000) - 60
    expect(
      usageFromRolloutRaw(line({ primary: { used_percent: 90, window_minutes: 300, resets_at: stale } }), NOW),
    ).toBe(null)
  })

  it("returns null for rollouts with no usable block, and survives malformed lines", () => {
    expect(usageFromRolloutRaw('{"type":"session_meta","payload":{"cwd":"/x"}}', NOW)).toBe(null)
    expect(usageFromRolloutRaw('{"rate_limits": broken', NOW)).toBe(null)
    expect(usageFromRolloutRaw(line({ primary: null, secondary: null }), NOW)).toBe(null)
  })
})
