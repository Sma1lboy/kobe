import { beforeEach, describe, expect, it } from "vitest"
import { ULID_ALPHABET, _resetUlidStateForTests, ulid } from "../../src/orchestrator/index/ulid.ts"

describe("ulid", () => {
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
    expect(earlier.slice(0, 10) < later.slice(0, 10)).toBe(true)
  })

  it("is strictly monotonic within the same millisecond", () => {
    const first = ulid(5000)
    const second = ulid(5000)
    const third = ulid(5000)
    expect(second > first).toBe(true)
    expect(third > second).toBe(true)
    expect(second.slice(0, 10)).toBe(first.slice(0, 10))
    expect(first.slice(0, 10)).toBe(third.slice(0, 10))
  })

  it("generates a distinct id per call", () => {
    const ids = new Set([ulid(9000), ulid(9000), ulid(9001), ulid(9001)])
    expect(ids.size).toBe(4)
  })
})
