import { beforeEach, describe, expect, it } from "vitest"
import { ULID_ALPHABET, _resetUlidStateForTests, ulid } from "../../src/orchestrator/index/ulid.ts"

describe("ulid", () => {
  // The monotonic state is module-global; reset it before each case so
  // same-millisecond assertions don't leak across tests.
  beforeEach(() => _resetUlidStateForTests())

  it("is 26 chars, all from the Crockford alphabet", () => {
    const id = ulid(0)
    expect(id).toHaveLength(26)
    for (const ch of id) expect(ULID_ALPHABET).toContain(ch)
  })

  it("encodes timestamp 0 as ten leading zeros", () => {
    expect(ulid(0).slice(0, 10)).toBe("0000000000")
  })

  it("sorts lexicographically by timestamp", () => {
    const earlier = ulid(1000)
    const later = ulid(2000)
    expect(earlier < later).toBe(true)
    // The timestamp lives in the high-order 10 chars, so the prefix alone
    // orders them regardless of the random tail.
    expect(earlier.slice(0, 10) < later.slice(0, 10)).toBe(true)
  })

  it("is strictly monotonic within the same millisecond", () => {
    const first = ulid(5000)
    const second = ulid(5000)
    const third = ulid(5000)
    expect(second > first).toBe(true)
    expect(third > second).toBe(true)
    // Same ms → identical time prefix; only the random tail advances.
    expect(second.slice(0, 10)).toBe(first.slice(0, 10))
    expect(first.slice(0, 10)).toBe(third.slice(0, 10))
  })

  it("stays monotonic when the wall clock steps backward", () => {
    const first = ulid(9000)
    // Clock jumps back (NTP correction, VM resume). The id must still sort
    // strictly after the previous one, so its timestamp prefix is held at
    // the last-seen 9000 rather than regressing to 8000.
    const second = ulid(8000)
    expect(second > first).toBe(true)
    expect(second.slice(0, 10)).toBe(first.slice(0, 10))
  })

  it("resumes fresh randomness once the clock catches back up", () => {
    const first = ulid(9000)
    const held = ulid(8000)
    // Held at 9000 by the backward-step guard...
    expect(held.slice(0, 10)).toBe(first.slice(0, 10))
    // ...and a later timestamp advances the prefix normally again.
    const later = ulid(9001)
    expect(later > held).toBe(true)
    expect(later.slice(0, 10) > first.slice(0, 10)).toBe(true)
  })

  it("generates a distinct id per call", () => {
    const ids = new Set([ulid(9000), ulid(9000), ulid(9001), ulid(9001)])
    expect(ids.size).toBe(4)
  })
})
