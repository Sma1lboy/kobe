import { describe, expect, it } from "vitest"
import { handleOrchestratorEvent } from "../../src/client/remote-orchestrator-events.ts"
import type { OrchestratorSignals } from "../../src/client/remote-orchestrator-payloads.ts"

/**
 * Transient lifecycle marks must never outlive their evidence (the
 * 2026-07-29 stale-mark class): a cancelled compaction sends no
 * post-compact and an esc-interrupted turn may send no idle/stop, so the
 * fold clears marks on every turn edge — and keeps NO compaction state at
 * all, since that one has no reliable clearing event.
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
  it("compaction leaves NO client state — an unclearable flag is never created", () => {
    const { signals, lifecycle } = fakeSignals()
    handleOrchestratorEvent("engine-state", { taskId: "t1", state: "running", at: 1 }, signals)
    handleOrchestratorEvent("engine.lifecycle", { taskId: "t1", kind: "pre-compact", at: 2 }, signals)
    expect(lifecycle().has("t1")).toBe(false)
    // …so an esc that cancels the compaction has nothing to strand.
    handleOrchestratorEvent("engine.lifecycle", { taskId: "t1", kind: "post-compact", at: 3 }, signals)
    expect(lifecycle().has("t1")).toBe(false)
  })

  it("a fresh running edge clears a subagent mark stranded by an interrupt", () => {
    const { signals, lifecycle } = fakeSignals()
    handleOrchestratorEvent("engine-state", { taskId: "t1", state: "running", at: 1 }, signals)
    handleOrchestratorEvent("engine.lifecycle", { taskId: "t1", kind: "subagent-start", at: 2 }, signals)
    expect(lifecycle().get("t1")).toMatchObject({ subagents: 1 })
    // esc: no subagent-stop, no idle — the next turn's running edge clears it.
    handleOrchestratorEvent("engine-state", { taskId: "t1", state: "idle", at: 3 }, signals)
    handleOrchestratorEvent("engine-state", { taskId: "t1", state: "running", at: 4 }, signals)
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
