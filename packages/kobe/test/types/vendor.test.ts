import { describe, expect, it } from "vitest"
import { ALL_VENDORS, nextVendor, nextVendorWithin } from "../../src/types/vendor.ts"

describe("nextVendor", () => {
  it("walks ALL_VENDORS in order and wraps", () => {
    expect(nextVendor("claude")).toBe("codex")
    expect(nextVendor("codex")).toBe("copilot")
    expect(nextVendor("copilot")).toBe("claude")
  })
})

describe("nextVendorWithin", () => {
  it("cycles within a subset, wrapping around", () => {
    const set = ["claude", "copilot"] as const
    expect(nextVendorWithin(set, "claude")).toBe("copilot")
    expect(nextVendorWithin(set, "copilot")).toBe("claude")
  })

  it("starts from the first entry when current is not in the subset", () => {
    // codex was filtered out (not detected); cycling from it lands on the first.
    expect(nextVendorWithin(["claude", "copilot"], "codex")).toBe("claude")
  })

  it("returns current unchanged for an empty subset (nothing detected)", () => {
    expect(nextVendorWithin([], "codex")).toBe("codex")
  })

  it("is a no-op cycle for a single-vendor subset", () => {
    expect(nextVendorWithin(["codex"], "codex")).toBe("codex")
  })

  it("agrees with nextVendor when the subset is the full list", () => {
    for (const v of ALL_VENDORS) expect(nextVendorWithin(ALL_VENDORS, v)).toBe(nextVendor(v))
  })
})
