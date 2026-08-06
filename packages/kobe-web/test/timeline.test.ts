import { describe, expect, it } from "vitest"
import { durationMs, withLiveState } from "../src/lib/timeline.ts"
import type { EngineTrace, TraceTurn } from "../src/lib/trace.ts"

const SESSION_ID = "codex-session"

function model(turns: TraceTurn[] = []): EngineTrace {
  return { sessionId: SESSION_ID, turns }
}

function turn(
  status: TraceTurn["status"],
  endedAt: number | null,
): TraceTurn {
  return {
    id: "turn-1",
    title: "Inspect the failing test",
    startedAt: 10,
    endedAt,
    status,
    nodes: [],
  }
}

describe("withLiveState", () => {
  it("shows activity before the engine trace persists", () => {
    const timeline = withLiveState(model(), "running", 42)
    expect(timeline.turns[0]).toMatchObject({
      id: `turn:live:${SESSION_ID}`,
      title: "Current turn",
      status: "running",
      startedAt: 42,
      nodes: [],
    })
  })

  it("overlays an active trace turn without synthesizing a duplicate", () => {
    const timeline = withLiveState(model([turn("running", 20)]), "running", 30)
    expect(timeline.turns).toHaveLength(1)
    expect(timeline.turns[0]).toMatchObject({
      id: "turn-1",
      status: "running",
      endedAt: null,
    })
  })

  it("adds a live root when daemon activity starts after a completed turn", () => {
    const timeline = withLiveState(model([turn("success", 20)]), "running", 30)
    expect(timeline.turns).toHaveLength(2)
    expect(timeline.turns[1]).toMatchObject({
      id: `turn:live:${SESSION_ID}:30`,
      title: "Current turn",
      status: "running",
      startedAt: 30,
    })
  })

  it("uses blocked language without inventing causal nodes", () => {
    const timeline = withLiveState(model(), "permission_needed", 42)
    expect(timeline.turns[0]).toMatchObject({
      title: "Waiting for input",
      status: "blocked",
      nodes: [],
    })
  })

  it("leaves a settled trace untouched for unrelated daemon states", () => {
    const settled = model([turn("success", 20)])
    expect(withLiveState(settled, "idle", 30)).toBe(settled)
  })
})

describe("durationMs", () => {
  it("uses now only for running ranges and never returns a negative duration", () => {
    expect(durationMs(10, 25, 100)).toBe(15)
    expect(durationMs(10, null, 25)).toBe(15)
    expect(durationMs(25, 10, 100)).toBe(0)
  })
})
