import { describe, expect, it } from "vitest"
import type { TaskEngineState } from "../../src/client/remote-orchestrator-payloads.ts"
import {
  mergeOptimisticActivity,
  noteEngineInput,
  optimisticActivityStore,
  resetOptimisticActivity,
  supersededMarks,
} from "../../src/tui-react/workspace/optimistic-activity.ts"

const auth = (entries: Record<string, TaskEngineState>): ReadonlyMap<string, TaskEngineState> =>
  new Map(Object.entries(entries))

describe("mergeOptimisticActivity", () => {
  it("a fresh running mark spins an idle task; authoritative-newer wins", () => {
    const marks = new Map([["t1", { kind: "running" as const, at: 1000 }]])
    const merged = mergeOptimisticActivity(auth({}), marks, 1500)
    expect(merged.get("t1")?.state).toBe("running")
    // Authoritative event at/after the mark outranks it (even a terminal one).
    const settled = mergeOptimisticActivity(auth({ t1: { state: "turn_complete", at: 2000 } }), marks, 2500)
    expect(settled.get("t1")?.state).toBe("turn_complete")
  })

  it("an interrupted mark silences a running task until authority catches up", () => {
    const marks = new Map([["t1", { kind: "interrupted" as const, at: 3000 }]])
    const merged = mergeOptimisticActivity(auth({ t1: { state: "running", at: 1000 } }), marks, 3200)
    expect(merged.has("t1")).toBe(false)
    // A NEWER authoritative running (the esc guess was wrong) wins again.
    const corrected = mergeOptimisticActivity(auth({ t1: { state: "running", at: 4000 } }), marks, 4200)
    expect(corrected.get("t1")?.state).toBe("running")
  })

  it("THE /compact-then-esc bug: state older than the interrupt never resurfaces", () => {
    // esc during /compact: the engine sends no post-compact and no Stop, so
    // this `running` entry is frozen at t=1000 forever. Minutes later it
    // must still read as quiet — an interrupt is a fact about the past, not
    // a guess that decays back into stale state.
    const stale = auth({ t1: { state: "running", at: 1000 } })
    const marks = new Map([["t1", { kind: "interrupted" as const, at: 2000 }]])
    for (const now of [2100, 7000, 60_000, 15 * 60_000]) {
      expect(mergeOptimisticActivity(stale, marks, now).has("t1")).toBe(false)
    }
  })

  it("an expired running guess decays back to authority", () => {
    const base = auth({})
    const marks = new Map([["t1", { kind: "running" as const, at: 1000 }]])
    expect(mergeOptimisticActivity(base, marks, 60_000)).toBe(base)
  })
})

describe("supersededMarks", () => {
  it("names marks an authoritative event at/after them has settled", () => {
    const marks = new Map([
      ["t1", { kind: "running" as const, at: 1000 }],
      ["t2", { kind: "interrupted" as const, at: 1000 }],
    ])
    const settled = supersededMarks(
      auth({ t1: { state: "running", at: 1500 }, t2: { state: "running", at: 500 } }),
      marks,
    )
    expect(settled).toEqual(["t1"])
  })
})

describe("noteEngineInput", () => {
  it("enter marks running, bare esc marks interrupted, other keys are ignored", () => {
    resetOptimisticActivity()
    noteEngineInput("t1", "h")
    noteEngineInput("t1", "\x1b[A") // arrow — not a bare esc
    expect(optimisticActivityStore.get().size).toBe(0)
    noteEngineInput("t1", "\r")
    expect(optimisticActivityStore.get().get("t1")?.kind).toBe("running")
    noteEngineInput("t1", "\x1b")
    expect(optimisticActivityStore.get().get("t1")?.kind).toBe("interrupted")
    resetOptimisticActivity()
  })
})
