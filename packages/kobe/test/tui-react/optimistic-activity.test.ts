import { describe, expect, it } from "vitest"
import type { TaskEngineState } from "../../src/client/remote-orchestrator-payloads.ts"
import {
  answeredTabsStore,
  mergeAnsweredTabs,
  mergeOptimisticActivity,
  noteEngineInput,
  noteEngineTabInput,
  optimisticActivityStore,
  resetOptimisticActivity,
  supersededAnswers,
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

/**
 * Answering an AskUserQuestion resumes the SAME turn, so claude emits no
 * Stop and no UserPromptSubmit, while `permission_needed` is deliberately
 * sticky (the lapse watchdog must not idle a task that needs a human). With
 * no event to clear it the tab's `?` pinned forever — observed in production
 * on a tab still showing it 11 minutes after the engine had resumed working.
 * The enter typed at that tab is the only evidence the answer happened.
 */
describe("mergeAnsweredTabs", () => {
  const tabs = (entries: Record<string, Record<string, TaskEngineState>>) =>
    new Map(Object.entries(entries).map(([task, byTab]) => [task, new Map(Object.entries(byTab))]))

  it("hides a permission_needed the user answered, until a newer event arrives", () => {
    const waiting = tabs({ t1: { "tab-27": { state: "permission_needed", at: 1000 } } })
    const marks = new Map([["t1::tab-27", 2000]])
    expect(mergeAnsweredTabs(waiting, marks, 2500).get("t1")?.get("tab-27")).toBeUndefined()

    // A daemon event stamped after the answer is real news — it wins.
    const resumed = tabs({ t1: { "tab-27": { state: "permission_needed", at: 3000 } } })
    expect(mergeAnsweredTabs(resumed, marks, 3500).get("t1")?.get("tab-27")?.state).toBe("permission_needed")
  })

  it("touches only the answered tab, and only permission_needed", () => {
    const mixed = tabs({
      t1: {
        "tab-27": { state: "permission_needed", at: 1000 },
        "tab-22": { state: "permission_needed", at: 1000 },
        "tab-9": { state: "error", at: 1000 },
      },
    })
    const merged = mergeAnsweredTabs(mixed, new Map([["t1::tab-27", 2000]]), 2500)
    expect(merged.get("t1")?.get("tab-27")).toBeUndefined()
    // A sibling's prompt and an unrelated error must survive: a local guess
    // may never hide a state the user still has to act on.
    expect(merged.get("t1")?.get("tab-22")?.state).toBe("permission_needed")
    expect(merged.get("t1")?.get("tab-9")?.state).toBe("error")
  })

  it("only an enter at a WAITING tab marks an answer", () => {
    resetOptimisticActivity()
    noteEngineTabInput("\r", "t1", "tab-1", "idle")
    expect(answeredTabsStore.get().size).toBe(0)
    noteEngineTabInput("x", "t1", "tab-1", "permission_needed")
    expect(answeredTabsStore.get().size).toBe(0)
    noteEngineTabInput("\r", "t1", "tab-1", "permission_needed")
    expect([...answeredTabsStore.get().keys()]).toEqual(["t1::tab-1"])
    resetOptimisticActivity()
  })

  it("drops a mark once the daemon supersedes it or it ages out", () => {
    const gone = tabs({ t1: {} })
    expect(supersededAnswers(gone, new Map([["t1::tab-27", 2000]]), 2500)).toEqual(["t1::tab-27"])
    const still = tabs({ t1: { "tab-27": { state: "permission_needed", at: 1000 } } })
    expect(supersededAnswers(still, new Map([["t1::tab-27", 2000]]), 2500)).toEqual([])
    // Past the memory bound the mark is dropped regardless.
    expect(supersededAnswers(still, new Map([["t1::tab-27", 2000]]), 2000 + 31 * 60_000)).toEqual(["t1::tab-27"])
  })
})
