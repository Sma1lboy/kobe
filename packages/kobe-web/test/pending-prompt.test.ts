import { describe, expect, it } from "vitest"
import { consumePendingPrompt, setPendingPrompt } from "../src/lib/tabs.ts"


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
