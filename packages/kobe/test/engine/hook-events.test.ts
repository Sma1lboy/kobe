import { describe, expect, it } from "vitest"
import { isEngineActivityKind, reduceActivity } from "../../src/engine/hook-events.ts"

/**
 * The neutral state machine that turns normalized hook verbs into the badge
 * state the sidebar renders. Pure — this is where the engine→UI mapping is
 * pinned, vendor-agnostic.
 */
describe("reduceActivity", () => {
  it("maps each verb to the right activity state", () => {
    expect(reduceActivity(undefined, "session-start")).toBe("idle")
    expect(reduceActivity(undefined, "turn-start")).toBe("running")
    expect(reduceActivity("running", "turn-complete")).toBe("turn_complete")
    expect(reduceActivity("running", "session-end")).toBe("idle")
  })

  it("classifies turn-failed by failure class", () => {
    expect(reduceActivity("running", "turn-failed", { failure: "rate_limit" })).toBe("rate_limited")
    expect(reduceActivity("running", "turn-failed", { failure: "billing" })).toBe("rate_limited")
    expect(reduceActivity("running", "turn-failed", { failure: "other" })).toBe("error")
    expect(reduceActivity("running", "turn-failed")).toBe("error")
  })

  it("treats awaiting-input as permission_needed — permission prompt AND question dialog", () => {
    // Owner call 2026-07-12: a question dialog blocks the engine on the user
    // exactly like a permission prompt, and F7 must reach it. `detail.waiting`
    // keeps which one it was.
    expect(reduceActivity("running", "awaiting-input", { waiting: "permission" })).toBe("permission_needed")
    expect(reduceActivity("running", "awaiting-input", { waiting: "input" })).toBe("permission_needed")
  })
})

describe("isEngineActivityKind", () => {
  it("accepts the six normalized verbs and rejects others", () => {
    for (const v of ["session-start", "turn-start", "turn-complete", "turn-failed", "awaiting-input", "session-end"]) {
      expect(isEngineActivityKind(v)).toBe(true)
    }
    expect(isEngineActivityKind("Stop")).toBe(false)
    expect(isEngineActivityKind("")).toBe(false)
  })
})
