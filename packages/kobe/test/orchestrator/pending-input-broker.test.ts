/**
 * Unit tests for the in-memory PendingInputBroker. This is the
 * canonical adapter used by both the local Orchestrator and (via
 * the wire) the RemoteOrchestrator — every drift bug that previously
 * lived as duplicated map-mutation code now collapses to "did the
 * broker do the right thing."
 */

import { describe, expect, test } from "vitest"
import { InMemoryPendingInputBroker } from "../../src/orchestrator/pending-input-broker.ts"
import type { ApprovePlanPayload } from "../../src/types/engine.ts"

function approve(plan: string): ApprovePlanPayload {
  return { kind: "approve_plan", plan, filePath: null }
}

describe("InMemoryPendingInputBroker", () => {
  test("record + snapshot round-trips entries in record order", () => {
    const broker = new InMemoryPendingInputBroker()
    const a = approve("plan A")
    const b = approve("plan B")
    broker.record("task-1", "task-1:tab-x", "req-1", a)
    broker.record("task-1", "task-1:tab-y", "req-2", b)
    expect(broker.snapshot("task-1")).toEqual([
      { requestId: "req-1", payload: a, tabKey: "task-1:tab-x" },
      { requestId: "req-2", payload: b, tabKey: "task-1:tab-y" },
    ])
  })

  test("snapshot returns a defensive copy", () => {
    const broker = new InMemoryPendingInputBroker()
    broker.record("task-1", "task-1:tab-x", "req-1", approve("p"))
    const snap = broker.snapshot("task-1")
    snap.push({ requestId: "FAKE", payload: approve("evil"), tabKey: "task-1:tab-x" })
    expect(broker.snapshot("task-1")).toHaveLength(1)
  })

  test("record is idempotent on (taskId, requestId)", () => {
    // Wire replays (chat.input.pending hydration + subsequent
    // user_input.request event for the same id) must not double-count.
    const broker = new InMemoryPendingInputBroker()
    const payload = approve("plan")
    broker.record("task-1", "task-1:tab-x", "req-1", payload)
    broker.record("task-1", "task-1:tab-x", "req-1", payload)
    expect(broker.snapshot("task-1")).toEqual([{ requestId: "req-1", payload, tabKey: "task-1:tab-x" }])
  })

  test("resolve pops the entry and returns its tabKey", () => {
    const broker = new InMemoryPendingInputBroker()
    const payload = approve("plan")
    broker.record("task-1", "task-1:tab-x", "req-1", payload)
    const resolved = broker.resolve("task-1", "req-1")
    expect(resolved).toEqual({ requestId: "req-1", payload, tabKey: "task-1:tab-x" })
    expect(broker.snapshot("task-1")).toEqual([])
  })

  test("resolve returns null for unknown requests", () => {
    const broker = new InMemoryPendingInputBroker()
    expect(broker.resolve("task-1", "req-missing")).toBeNull()
    broker.record("task-1", "task-1:tab-x", "req-1", approve("plan"))
    broker.resolve("task-1", "req-1")
    // Second resolve is also a miss — the bucket is drained.
    expect(broker.resolve("task-1", "req-1")).toBeNull()
  })

  test("awaitingTabKeys yields every recorded tabKey across tasks", () => {
    const broker = new InMemoryPendingInputBroker()
    broker.record("task-1", "task-1:tab-x", "req-1", approve("a"))
    broker.record("task-2", "task-2:tab-y", "req-2", approve("b"))
    broker.record("task-1", "task-1:tab-z", "req-3", approve("c"))
    expect(new Set(broker.awaitingTabKeys())).toEqual(new Set(["task-1:tab-x", "task-2:tab-y", "task-1:tab-z"]))
    broker.resolve("task-1", "req-1")
    expect(new Set(broker.awaitingTabKeys())).toEqual(new Set(["task-2:tab-y", "task-1:tab-z"]))
  })

  test("clearForTask drops every entry for the task, leaves siblings", () => {
    const broker = new InMemoryPendingInputBroker()
    broker.record("task-1", "task-1:tab-x", "req-1", approve("a"))
    broker.record("task-1", "task-1:tab-y", "req-2", approve("b"))
    broker.record("task-2", "task-2:tab-z", "req-3", approve("c"))
    broker.clearForTask("task-1")
    expect(broker.snapshot("task-1")).toEqual([])
    expect(broker.snapshot("task-2")).toHaveLength(1)
    expect(new Set(broker.awaitingTabKeys())).toEqual(new Set(["task-2:tab-z"]))
  })

  test("clearForTask on unknown task is a no-op", () => {
    const broker = new InMemoryPendingInputBroker()
    broker.record("task-1", "task-1:tab-x", "req-1", approve("a"))
    expect(() => broker.clearForTask("task-missing")).not.toThrow()
    expect(broker.snapshot("task-1")).toHaveLength(1)
  })

  test("the bucket drops the task entry when the last request resolves", () => {
    // Sanity: snapshot returns [] for empty buckets without keeping
    // dangling Map entries around. Matters for leak hygiene on long-
    // running daemons.
    const broker = new InMemoryPendingInputBroker()
    broker.record("task-1", "task-1:tab-x", "req-1", approve("a"))
    broker.resolve("task-1", "req-1")
    // Re-recording after drain works (regression: old code accidentally
    // kept the empty Map and broke idempotency).
    broker.record("task-1", "task-1:tab-x", "req-2", approve("b"))
    expect(broker.snapshot("task-1")).toEqual([{ requestId: "req-2", payload: approve("b"), tabKey: "task-1:tab-x" }])
  })
})
