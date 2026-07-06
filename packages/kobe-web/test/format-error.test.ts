import { describe, expect, it } from "vitest"
import { formatError } from "../src/lib/toast.ts"


describe("formatError", () => {
  it("uses an Error's message as the cause", () => {
    expect(formatError("Rename failed", new Error("boom"))).toBe(
      "Rename failed: boom",
    )
  })

  it("stringifies a thrown string", () => {
    expect(formatError("Archive failed", "nope")).toBe("Archive failed: nope")
  })

  it("stringifies a non-Error object rather than dropping it", () => {
    expect(formatError("Create failed", { code: 500 })).toBe(
      "Create failed: [object Object]",
    )
  })

  it("handles null/undefined causes without throwing", () => {
    expect(formatError("X", null)).toBe("X: null")
    expect(formatError("X", undefined)).toBe("X: undefined")
  })

  it("preserves a subclassed Error's message", () => {
    class RpcError extends Error {}
    expect(formatError("rpc", new RpcError("timeout"))).toBe("rpc: timeout")
  })
})
