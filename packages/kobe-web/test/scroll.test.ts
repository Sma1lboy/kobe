import { describe, expect, it } from "vitest"
import { isNearBottom } from "../src/lib/scroll.ts"


describe("isNearBottom", () => {
  it("is true at the very bottom", () => {
    expect(isNearBottom(900, 1000, 100)).toBe(true)
  })

  it("is true within the default threshold", () => {
    expect(isNearBottom(870, 1000, 100)).toBe(true)
  })

  it("is false when scrolled well up", () => {
    expect(isNearBottom(0, 1000, 100)).toBe(false)
  })

  it("treats exactly at the threshold as NOT near (strict <)", () => {
    expect(isNearBottom(820, 1000, 100)).toBe(false)
  })

  it("honors a custom threshold", () => {
    expect(isNearBottom(700, 1000, 100, 300)).toBe(true)
    expect(isNearBottom(700, 1000, 100)).toBe(false)
  })

  it("is true for non-scrollable content (height <= viewport)", () => {
    expect(isNearBottom(0, 50, 100)).toBe(true)
  })
})
