import { describe, expect, it } from "vitest"
import { pruneByTask } from "../src/lib/store.ts"


describe("pruneByTask", () => {
  it("drops entries for tasks not in the live set", () => {
    const map = { a: 1, b: 2, c: 3 }
    expect(pruneByTask(map, new Set(["a", "c"]))).toEqual({ a: 1, c: 3 })
  })

  it("returns the SAME reference when nothing is dropped", () => {
    const map = { a: 1, b: 2 }
    expect(pruneByTask(map, new Set(["a", "b", "extra"]))).toBe(map)
  })

  it("returns a NEW object when something is dropped", () => {
    const map = { a: 1, b: 2 }
    const out = pruneByTask(map, new Set(["a"]))
    expect(out).not.toBe(map)
    expect(out).toEqual({ a: 1 })
  })

  it("returns an empty object when no key is live", () => {
    expect(pruneByTask({ a: 1, b: 2 }, new Set())).toEqual({})
  })

  it("handles an already-empty map (same ref)", () => {
    const map: Record<string, number> = {}
    expect(pruneByTask(map, new Set(["x"]))).toBe(map)
  })
})
