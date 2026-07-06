import { describe, expect, it } from "vitest"
import { isNearBottom } from "../src/lib/scroll.ts"

/**
 * isNearBottom decides transcript auto-follow + the jump-to-latest button. The
 * boundary is `distance-from-bottom < threshold`, so exactly at the threshold
 * is NOT "near" (the button stays). Default threshold 80px.
 */

describe("isNearBottom", () => {
  it("is true at the very bottom", () => {
    // scrollTop maxed: scrollHeight - scrollTop - clientHeight === 0
    expect(isNearBottom(900, 1000, 100)).toBe(true)
  })

  it("is true within the default threshold", () => {
    // distance = 1000 - 870 - 100 = 30 < 80
    expect(isNearBottom(870, 1000, 100)).toBe(true)
  })

  it("is false when scrolled well up", () => {
    // distance = 1000 - 0 - 100 = 900
    expect(isNearBottom(0, 1000, 100)).toBe(false)
  })

  it("treats exactly at the threshold as NOT near (strict <)", () => {
    // distance = 1000 - 820 - 100 = 80, not < 80
    expect(isNearBottom(820, 1000, 100)).toBe(false)
  })

  it("honors a custom threshold", () => {
    // distance = 200; near with threshold 300, not with 80
    expect(isNearBottom(700, 1000, 100, 300)).toBe(true)
    expect(isNearBottom(700, 1000, 100)).toBe(false)
  })

  it("is true for non-scrollable content (height <= viewport)", () => {
    // distance = 50 - 0 - 100 = -50 < 80
    expect(isNearBottom(0, 50, 100)).toBe(true)
  })
})
