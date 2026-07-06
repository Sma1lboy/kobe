import { describe, expect, it } from "vitest"
import { relativeTimeAgo } from "../src/lib/time.ts"

/**
 * relativeTimeAgo is the adopt dialog's verbose "X ago" formatter (distinct
 * from the rail's compact relativeTime). `now` is injected so the buckets are
 * deterministic. A falsy/zero timestamp renders empty (no "just now" for a
 * missing activity time).
 */

const NOW = 1_000_000_000_000
const ago = (ms: number) => relativeTimeAgo(NOW - ms, NOW)
const SEC = 1000
const MIN = 60 * SEC
const HR = 60 * MIN
const DAY = 24 * HR

describe("relativeTimeAgo", () => {
  it("renders empty for a falsy/zero timestamp", () => {
    expect(relativeTimeAgo(0, NOW)).toBe("")
  })

  it("says 'just now' under a minute", () => {
    expect(ago(0)).toBe("just now")
    expect(ago(30 * SEC)).toBe("just now")
  })

  it("buckets minutes", () => {
    expect(ago(5 * MIN)).toBe("5m ago")
  })

  it("buckets hours", () => {
    expect(ago(3 * HR)).toBe("3h ago")
  })

  it("buckets days", () => {
    expect(ago(2 * DAY)).toBe("2d ago")
    expect(ago(10 * DAY)).toBe("10d ago")
  })

  it("never goes negative for a future timestamp", () => {
    expect(relativeTimeAgo(NOW + 5 * MIN, NOW)).toBe("just now")
  })
})
