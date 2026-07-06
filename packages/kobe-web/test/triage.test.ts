import { describe, expect, it } from "vitest"
import { matchesStatusFilter, triage } from "../src/lib/triage.ts"
import type { EngineState } from "../src/lib/types.ts"


const eng = (state: EngineState["state"]): EngineState =>
  ({ taskId: "t", state, at: 1 }) as EngineState
const dirty = { added: 3, deleted: 1 }
const clean = { added: 0, deleted: 0 }

describe("triage", () => {
  it("routes human-needed states to 'attention'", () => {
    expect(triage(eng("waiting_permission"), undefined)).toBe("attention")
    expect(triage(eng("error"), undefined)).toBe("attention")
    expect(triage(eng("rate_limited"), undefined)).toBe("attention")
  })

  it("routes a running task to 'working'", () => {
    expect(triage(eng("running"), undefined)).toBe("working")
  })

  it("routes an idle-but-dirty task to 'changes'", () => {
    expect(triage(eng("idle"), dirty)).toBe("changes")
  })

  it("routes an idle-and-clean task to 'quiet'", () => {
    expect(triage(eng("idle"), clean)).toBe("quiet")
  })

  it("treats a task with no engine state as quiet (unless dirty)", () => {
    expect(triage(undefined, undefined)).toBe("quiet")
    expect(triage(undefined, dirty)).toBe("changes")
  })

  describe("priority order (the load-bearing part)", () => {
    it("attention outranks dirtiness (error + dirty → attention)", () => {
      expect(triage(eng("error"), dirty)).toBe("attention")
      expect(triage(eng("waiting_permission"), dirty)).toBe("attention")
    })

    it("working outranks dirtiness (running + dirty → working)", () => {
      expect(triage(eng("running"), dirty)).toBe("working")
    })

    it("only counts dirtiness when added OR deleted is > 0", () => {
      expect(triage(eng("idle"), { added: 0, deleted: 2 })).toBe("changes")
      expect(triage(eng("idle"), { added: 2, deleted: 0 })).toBe("changes")
      expect(triage(eng("idle"), { added: 0, deleted: 0 })).toBe("quiet")
    })
  })

  it("buckets an unknown engine state by dirtiness, not as working/attention", () => {
    expect(triage(eng("compacting"), dirty)).toBe("changes")
    expect(triage(eng("compacting"), clean)).toBe("quiet")
  })
})

describe("matchesStatusFilter (rail status chips)", () => {
  it("keeps every task when the filter is 'all'", () => {
    expect(matchesStatusFilter(eng("running"), dirty, "all")).toBe(true)
    expect(matchesStatusFilter(undefined, undefined, "all")).toBe(true)
  })

  it("keeps only tasks whose bucket matches the selected filter", () => {
    expect(matchesStatusFilter(eng("error"), clean, "attention")).toBe(true)
    expect(matchesStatusFilter(eng("running"), clean, "working")).toBe(true)
    expect(matchesStatusFilter(eng("idle"), dirty, "changes")).toBe(true)
  })

  it("drops tasks in a different bucket than the filter", () => {
    expect(matchesStatusFilter(eng("running"), dirty, "changes")).toBe(false)
    expect(matchesStatusFilter(eng("running"), dirty, "attention")).toBe(false)
    expect(matchesStatusFilter(eng("idle"), clean, "working")).toBe(false)
  })
})
