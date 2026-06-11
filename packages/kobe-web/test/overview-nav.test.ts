import { describe, expect, it } from "vitest"
import { moveHighlight, reconcileHighlight } from "../src/lib/overview-nav.ts"

// Why this matters: the Overview highlight is the keyboard path through the
// triage grid. The entry rules (down enters at top, up enters at bottom),
// clamping, and filter-survival are the whole contract — get them wrong and
// j/k feels broken in exactly the "many tasks, quick scan" moment Overview
// exists for.

const order = ["a", "b", "c"]

describe("moveHighlight", () => {
  it("returns null on an empty grid", () => {
    expect(moveHighlight([], null, 1)).toBeNull()
    expect(moveHighlight([], "a", -1)).toBeNull()
  })

  it("a fresh highlight enters at the top going down, bottom going up", () => {
    expect(moveHighlight(order, null, 1)).toBe("a")
    expect(moveHighlight(order, null, -1)).toBe("c")
  })

  it("moves through the flattened order and clamps at both ends", () => {
    expect(moveHighlight(order, "a", 1)).toBe("b")
    expect(moveHighlight(order, "b", -1)).toBe("a")
    expect(moveHighlight(order, "c", 1)).toBe("c")
    expect(moveHighlight(order, "a", -1)).toBe("a")
  })

  it("a highlight no longer in the order re-enters fresh", () => {
    expect(moveHighlight(order, "gone", 1)).toBe("a")
    expect(moveHighlight(order, "gone", -1)).toBe("c")
  })
})

describe("reconcileHighlight", () => {
  it("keeps a still-shown highlight (same reference, no-op setState)", () => {
    expect(reconcileHighlight(order, "b")).toBe("b")
  })

  it("clears a highlight whose card was filtered away", () => {
    expect(reconcileHighlight(order, "gone")).toBeNull()
    expect(reconcileHighlight([], "a")).toBeNull()
  })

  it("null stays null", () => {
    expect(reconcileHighlight(order, null)).toBeNull()
  })
})
