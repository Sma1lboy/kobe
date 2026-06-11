import { describe, expect, it } from "vitest"
import { consumePendingPrompt, setPendingPrompt } from "../src/lib/tabs.ts"

/**
 * New Task can seed a first prompt that lands in the engine composer once the
 * tab mounts. The handoff is a consume-ONCE Map: the prompt is read exactly
 * once (so a remount / re-render can't re-seed it) and is keyed per task (so
 * one task's seed never leaks into another). Distinct taskIds per test keep
 * the module-level Map from bleeding across cases.
 */

describe("pending prompt handoff", () => {
  it("returns null when nothing was set", () => {
    expect(consumePendingPrompt("none")).toBeNull()
  })

  it("returns the prompt once, then null (consume-once)", () => {
    setPendingPrompt("p1", "draft the migration")
    expect(consumePendingPrompt("p1")).toBe("draft the migration")
    expect(consumePendingPrompt("p1")).toBeNull()
  })

  it("keys by taskId — one task's seed never leaks to another", () => {
    setPendingPrompt("p2", "for two")
    expect(consumePendingPrompt("p3")).toBeNull()
    expect(consumePendingPrompt("p2")).toBe("for two")
  })

  it("treats an explicitly-set empty prompt as a value, not absence", () => {
    // `=== undefined` guard, not falsy: a deliberate "" is consumed as "",
    // distinct from never-set (null). Locks the contract against a `!prompt`
    // refactor that would silently collapse the two.
    setPendingPrompt("p4", "")
    expect(consumePendingPrompt("p4")).toBe("")
    expect(consumePendingPrompt("p4")).toBeNull()
  })

  it("a later set overwrites an unconsumed prompt for the same task", () => {
    setPendingPrompt("p5", "first")
    setPendingPrompt("p5", "second")
    expect(consumePendingPrompt("p5")).toBe("second")
  })
})
