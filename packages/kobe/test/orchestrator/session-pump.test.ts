/**
 * Unit tests for SessionPump in isolation.
 *
 * The whole point of the pump extract is that this lives standalone:
 * no Orchestrator instance, no Solid runtime, no store, no real
 * engine. A FakeAIEngine + an InMemoryPendingInputBroker + a record-
 * everything `dispatch` callback is everything needed to validate the
 * pump's three load-bearing behaviours:
 *
 *   1. Forwards every engine event to `dispatch` until the terminal,
 *      and returns the terminal event without dispatching it.
 *   2. On a pause tool, records into the broker, fires a synthetic
 *      `user_input.request`, kills the engine, and signals
 *      killedForInput.
 *   3. On error, returns the error event without dispatch (caller
 *      handles status + dispatch ordering).
 *
 * If these regress, the orchestrator's runPumpAndCleanup races
 * become invisible at this level of test — that's the whole win.
 */

import { describe, expect, test } from "vitest"
import { InMemoryPendingInputBroker } from "../../src/orchestrator/pending-input-broker.ts"
import { SessionPump } from "../../src/orchestrator/session-pump.ts"
import type { EngineEvent, OrchestratorEvent } from "../../src/types/engine.ts"
import { FakeAIEngine } from "../behavior/fake-engine.ts"

function newPump(opts?: { nextRequestId?: () => string }) {
  const engine = new FakeAIEngine()
  const broker = new InMemoryPendingInputBroker()
  const dispatched: Array<{ taskId: string; tabId: string; ev: OrchestratorEvent }> = []
  let counter = 0
  const pump = new SessionPump({
    engine,
    broker,
    dispatch: (taskId, tabId, ev) => {
      dispatched.push({ taskId, tabId, ev })
    },
    nextRequestId: opts?.nextRequestId ?? (() => `req-${++counter}`),
  })
  return { pump, engine, broker, dispatched }
}

describe("SessionPump", () => {
  test("forwards every non-terminal event and buffers the done", async () => {
    const { pump, engine, dispatched } = newPump()
    const handle = await engine.spawn("/tmp/x", "hi")
    engine.script(handle.sessionId, [
      { type: "assistant.delta", text: "hello" },
      { type: "assistant.delta", text: " world" },
      { type: "done" },
    ])
    const result = await pump.run("task-1", "tab-1", handle)
    expect(dispatched.map((d) => d.ev.type)).toEqual(["assistant.delta", "assistant.delta"])
    expect(result.terminalEvent).toEqual({ type: "done" })
    expect(result.killedForInput).toBe(false)
  })

  test("on a pause tool: records into the broker, dispatches user_input.request, kills the engine, signals killedForInput", async () => {
    const { pump, engine, broker, dispatched } = newPump({ nextRequestId: () => "req-fixed" })
    const handle = await engine.spawn("/tmp/x", "hi")
    engine.script(handle.sessionId, [
      {
        type: "tool.start",
        name: "ExitPlanMode",
        input: { plan: "# Plan\nstep 1" },
      },
      // Anything after the pause should never be observed — the pump
      // breaks the loop on the pause-tool dispatch.
      { type: "assistant.delta", text: "should not reach" },
      { type: "done" },
    ])
    const result = await pump.run("task-1", "tab-1", handle)

    // tool.start dispatched, then synthetic user_input.request.
    const types = dispatched.map((d) => d.ev.type)
    expect(types).toEqual(["tool.start", "user_input.request"])

    // Broker holds the request and attributes it to the firing tab.
    expect(broker.snapshot("task-1")).toEqual([
      {
        requestId: "req-fixed",
        payload: { kind: "approve_plan", plan: "# Plan\nstep 1", filePath: null },
        tabKey: "task-1:tab-1",
      },
    ])
    expect(Array.from(broker.awaitingTabKeys())).toEqual(["task-1:tab-1"])

    // killedForInput true, no terminal event returned — caller leaves
    // task `in_progress` so respondToInput can resume.
    expect(result.killedForInput).toBe(true)
    expect(result.terminalEvent).toBeNull()
  })

  test("invokes onPendingInputChange after recording into the broker", async () => {
    // The orchestrator wires onPendingInputChange → bumpRunState so
    // the awaiting_input dot lights up in the same render frame as
    // the user_input.request event. If this callback misfires, the
    // chat-tab chip stays green during pause.
    let bumpCount = 0
    const engine = new FakeAIEngine()
    const broker = new InMemoryPendingInputBroker()
    const pump = new SessionPump({
      engine,
      broker,
      dispatch: () => {},
      nextRequestId: () => "req-1",
      onPendingInputChange: () => bumpCount++,
    })
    const handle = await engine.spawn("/tmp/x", "hi")
    engine.script(handle.sessionId, [{ type: "tool.start", name: "ExitPlanMode", input: { plan: "p" } }])
    await pump.run("task-1", "tab-1", handle)
    expect(bumpCount).toBe(1)
  })

  test("on terminal error: returns the error event without dispatching it", async () => {
    // The orchestrator dispatches the terminal event AFTER its
    // post-cleanup so subscribers reacting to `error` see the
    // handles map + store status fully settled. Pump returning
    // (not dispatching) the terminal is what enforces that ordering.
    const { pump, engine, dispatched } = newPump()
    const handle = await engine.spawn("/tmp/x", "hi")
    engine.script(handle.sessionId, [
      { type: "assistant.delta", text: "partial" },
      { type: "error", message: "boom" },
    ])
    const result = await pump.run("task-1", "tab-1", handle)
    expect(dispatched.map((d) => d.ev.type)).toEqual(["assistant.delta"])
    expect(result.terminalEvent).toEqual({ type: "error", message: "boom" } satisfies EngineEvent)
    expect(result.killedForInput).toBe(false)
  })

  test("engine.stop is called in the finally for natural completions", async () => {
    // Defensive: even after a clean done, the pump's finally invokes
    // engine.stop so registry slots are freed before subscribers
    // react. Idempotent on the real engine; we just verify the call
    // happened on the fake.
    let stops = 0
    const baseEngine = new FakeAIEngine()
    const originalStop = baseEngine.stop.bind(baseEngine)
    baseEngine.stop = async (...args) => {
      stops++
      return originalStop(...args)
    }
    const pump = new SessionPump({
      engine: baseEngine,
      broker: new InMemoryPendingInputBroker(),
      dispatch: () => {},
      nextRequestId: () => "req-1",
    })
    const handle = await baseEngine.spawn("/tmp/x", "hi")
    baseEngine.script(handle.sessionId, [{ type: "done" }])
    await pump.run("task-1", "tab-1", handle)
    expect(stops).toBe(1)
  })
})
