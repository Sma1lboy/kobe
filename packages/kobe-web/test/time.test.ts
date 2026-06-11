import { describe, expect, it } from "vitest"
import { relativeTime } from "../src/lib/time.ts"

const NOW = 1_000_000_000_000 // fixed reference so buckets are deterministic
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe("relativeTime", () => {
  it("returns 'now' for very recent times", () => {
    expect(relativeTime(ago(0), NOW)).toBe("now")
    expect(relativeTime(ago(30 * SEC), NOW)).toBe("now")
  })

  it("buckets minutes", () => {
    expect(relativeTime(ago(3 * MIN), NOW)).toBe("3m")
    expect(relativeTime(ago(59 * MIN), NOW)).toBe("59m")
  })

  it("buckets hours", () => {
    expect(relativeTime(ago(2 * HOUR), NOW)).toBe("2h")
    expect(relativeTime(ago(23 * HOUR), NOW)).toBe("23h")
  })

  it("buckets days then weeks then months then years", () => {
    expect(relativeTime(ago(3 * DAY), NOW)).toBe("3d")
    expect(relativeTime(ago(2 * 7 * DAY), NOW)).toBe("2w")
    expect(relativeTime(ago(60 * DAY), NOW)).toBe("2mo")
    expect(relativeTime(ago(400 * DAY), NOW)).toBe("1y")
  })

  it("returns empty string for an unparseable timestamp", () => {
    expect(relativeTime("not-a-date", NOW)).toBe("")
  })

  it("never returns a negative bucket for a future timestamp", () => {
    expect(relativeTime(new Date(NOW + 10 * MIN).toISOString(), NOW)).toBe("now")
  })
})
