import { describe, expect, it } from "vitest"
import {
  ALL_VENDORS,
  coerceVendorId,
  isBuiltinVendor,
  nextVendor,
  nextVendorWithin,
  resolvePersistedVendor,
} from "../../src/types/vendor.ts"

describe("nextVendor", () => {
  it("walks ALL_VENDORS in order and wraps", () => {
    expect(nextVendor("claude")).toBe("codex")
    expect(nextVendor("codex")).toBe("copilot")
    expect(nextVendor("copilot")).toBe("kimi")
    expect(nextVendor("kimi")).toBe("claude")
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

describe("isBuiltinVendor", () => {
  it("is true only for the three first-party engines", () => {
    expect(isBuiltinVendor("claude")).toBe(true)
    expect(isBuiltinVendor("codex")).toBe(true)
    expect(isBuiltinVendor("copilot")).toBe(true)
    expect(isBuiltinVendor("aider")).toBe(false)
    expect(isBuiltinVendor(undefined)).toBe(false)
  })
})

describe("coerceVendorId", () => {
  it("passes a built-in through unchanged", () => {
    expect(coerceVendorId("codex")).toBe("codex")
  })

  it("passes a custom engine id through (engines are open now)", () => {
    expect(coerceVendorId("aider")).toBe("aider")
    expect(coerceVendorId("  my-engine ")).toBe("my-engine")
  })

  it("falls back to claude only for empty/absent", () => {
    expect(coerceVendorId(undefined)).toBe("claude")
    expect(coerceVendorId("")).toBe("claude")
    expect(coerceVendorId("   ")).toBe("claude")
  })
})

describe("resolvePersistedVendor", () => {
  it("passes a built-in through unchanged", () => {
    expect(resolvePersistedVendor("codex")).toBe("codex")
    expect(resolvePersistedVendor("copilot")).toBe("copilot")
    expect(resolvePersistedVendor("  claude ")).toBe("claude")
  })

  it("passes a registered custom engine id through", () => {
    expect(resolvePersistedVendor("aider", ["aider"])).toBe("aider")
    expect(resolvePersistedVendor("  my-engine ", ["my-engine"])).toBe("my-engine")
  })

  it("falls back to claude for an unregistered / typo'd value", () => {
    // garbage that is neither a built-in nor a known custom id
    expect(resolvePersistedVendor("clade")).toBe("claude")
    expect(resolvePersistedVendor("aider")).toBe("claude") // not in the (empty) custom registry
    expect(resolvePersistedVendor("aider", ["other-engine"])).toBe("claude")
  })

  it("falls back to claude for empty/absent", () => {
    expect(resolvePersistedVendor(undefined)).toBe("claude")
    expect(resolvePersistedVendor("")).toBe("claude")
    expect(resolvePersistedVendor("   ")).toBe("claude")
    expect(resolvePersistedVendor(undefined, ["aider"])).toBe("claude")
  })
})
