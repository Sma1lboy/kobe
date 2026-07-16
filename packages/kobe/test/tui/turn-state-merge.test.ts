/**
 * Hook-wins merge (`turn-state-merge.ts`) — the precedence rule between the
 * daemon's hook-driven per-tab engine state and the local quiescence poll.
 * Why these matter: the merge is the consolidation seam — if the mapping
 * table drifts from the daemon vocabulary, or hook data stops superseding
 * the poll (or supersedes when absent), the tab chip silently falls back to
 * the 3–6 s poll path and the latency win evaporates without any test
 * failing elsewhere.
 */

import { describe, expect, it } from "vitest"
import type { ChatTabTurnState } from "../../src/engine/turn-detector"
import { activityTurnState, mergeTurnStates } from "../../src/tui/workspace/turn-state-merge"

describe("activityTurnState", () => {
  it("maps the daemon vocabulary to the chip vocabulary (D2 table)", () => {
    expect(activityTurnState("running")).toBe("running")
    expect(activityTurnState("turn_complete")).toBe("done")
    expect(activityTurnState("error")).toBe("error")
    expect(activityTurnState("rate_limited")).toBe("error")
    expect(activityTurnState("permission_needed")).toBe("needs_input")
  })

  it("treats idle as no-claim (poll owns the chip)", () => {
    expect(activityTurnState("idle")).toBeNull()
  })
})

describe("mergeTurnStates", () => {
  const poll = new Map<string, ChatTabTurnState>([
    ["tab-1", "running"],
    ["tab-2", "idle"],
  ])

  it("returns the poll map by reference when there is no hook data", () => {
    expect(mergeTurnStates(undefined, poll)).toBe(poll)
    expect(mergeTurnStates(new Map(), poll)).toBe(poll)
  })

  it("hook entry supersedes the poll reading for that tab only", () => {
    const hook = new Map([["tab-1", { state: "turn_complete" as const }]])
    const merged = mergeTurnStates(hook, poll)
    expect(merged.get("tab-1")).toBe("done")
    expect(merged.get("tab-2")).toBe("idle") // untouched
  })

  it("adds hook-only tabs the poll has no detector for", () => {
    const hook = new Map([["tab-9", { state: "permission_needed" as const }]])
    const merged = mergeTurnStates(hook, poll)
    expect(merged.get("tab-9")).toBe("needs_input")
    expect(merged.size).toBe(3)
  })

  it("a replayed idle hook entry does not clobber the poll (no-claim)", () => {
    const hook = new Map([["tab-1", { state: "idle" as const }]])
    expect(mergeTurnStates(hook, poll)).toBe(poll)
  })
})
