import { describe, expect, it } from "vitest"
import { pruneByTask } from "../src/lib/store.ts"

/**
 * pruneByTask sweeps per-task side tables (engine states, jobs) to the live
 * task set on each snapshot — the round-2 fix that keeps a deleted task's
 * stale entry from lingering. The same-ref-when-unchanged behavior matters
 * so React doesn't re-render needlessly.
 */

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
