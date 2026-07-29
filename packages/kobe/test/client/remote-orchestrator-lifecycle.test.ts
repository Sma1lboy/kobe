import { describe, expect, it } from "vitest"
import { handleOrchestratorEvent } from "../../src/client/remote-orchestrator-events.ts"
import type { OrchestratorSignals } from "../../src/client/remote-orchestrator-payloads.ts"

/**
 * The stale-"compacting" regression (2026-07-29): a cancelled compaction
 * never sends post-compact, and an esc-interrupted turn may send no
 * idle/stop either — so the next prompt's fresh `running` edge is the
 * lifecycle mark's only chance to un-stick. These tests pin the fold's
 * clearing rules end to end through `handleOrchestratorEvent`.
 */
function fakeSignals(): { signals: OrchestratorSignals; lifecycle: () => ReadonlyMap<string, unknown> } {
  const cells = new Map<string, unknown>([
    ["engineState", new Map()],
    ["engineTabState", new Map()],
    ["engineLifecycle", new Map()],
  ])
  const signals = {
    engineStateAcc: () => cells.get("engineState"),
    setEngineStateSig: (next: unknown) => cells.set("engineState", next),
    engineTabStateAcc: () => cells.get("engineTabState"),
    setEngineTabStateSig: (next: unknown) => cells.set("engineTabState", next),
    engineLifecycleAcc: () => cells.get("engineLifecycle"),
    setEngineLifecycleSig: (next: unknown) => cells.set("engineLifecycle", next),
  } as unknown as OrchestratorSignals
  return { signals, lifecycle: () => cells.get("engineLifecycle") as ReadonlyMap<string, unknown> }
}

describe("engine.lifecycle marks vs engine-state edges", () => {
  it("a fresh running edge clears a mark stranded by a cancelled compaction", () => {
    const { signals, lifecycle } = fakeSignals()
    handleOrchestratorEvent("engine-state", { taskId: "t1", state: "running", at: 1 }, signals)
    handleOrchestratorEvent("engine.lifecycle", { taskId: "t1", kind: "pre-compact", at: 2 }, signals)
    expect(lifecycle().get("t1")).toMatchObject({ compacting: true })
    // esc: compaction cancelled, no post-compact, no idle/stop ever arrives;
    // the entry decays via idle elsewhere or the task re-enters directly.
    handleOrchestratorEvent("engine-state", { taskId: "t1", state: "idle", at: 3 }, signals)
    handleOrchestratorEvent("engine-state", { taskId: "t1", state: "running", at: 4 }, signals)
    expect(lifecycle().has("t1")).toBe(false)
  })

  it("a mid-turn compacting mark survives repeated running reports (no edge)", () => {
    const { signals, lifecycle } = fakeSignals()
    handleOrchestratorEvent("engine-state", { taskId: "t1", state: "running", at: 1 }, signals)
    handleOrchestratorEvent("engine.lifecycle", { taskId: "t1", kind: "pre-compact", at: 2 }, signals)
    handleOrchestratorEvent("engine-state", { taskId: "t1", state: "running", at: 3 }, signals)
    expect(lifecycle().get("t1")).toMatchObject({ compacting: true })
    handleOrchestratorEvent("engine.lifecycle", { taskId: "t1", kind: "post-compact", at: 4 }, signals)
    expect(lifecycle().has("t1")).toBe(false)
  })

  it("turn_complete and error both end every transient mark", () => {
    for (const terminal of ["turn_complete", "error"]) {
      const { signals, lifecycle } = fakeSignals()
      handleOrchestratorEvent("engine-state", { taskId: "t1", state: "running", at: 1 }, signals)
      handleOrchestratorEvent("engine.lifecycle", { taskId: "t1", kind: "subagent-start", at: 2 }, signals)
      expect(lifecycle().get("t1")).toMatchObject({ subagents: 1 })
      handleOrchestratorEvent("engine-state", { taskId: "t1", state: terminal, at: 3 }, signals)
      expect(lifecycle().has("t1")).toBe(false)
    }
  })
})
