/**
 * Unit tests for `FakeAIEngine`.
 *
 * These verify the behaviors the harness contract depends on:
 *   - `script()` events come back in order.
 *   - The async iterator awakens when new events are pushed *after*
 *     the consumer has caught up (the wait-then-push race).
 *   - `stop()` cleanly terminates an in-flight stream.
 *   - `readHistory()` returns whatever was pre-seeded.
 */

import { describe, expect, test } from "vitest"
import type { EngineEvent } from "./_engine-types"
import { FakeAIEngine } from "./fake-engine"

describe("FakeAIEngine", () => {
  test("scripted events stream in order, terminating on `done`", async () => {
    const engine = new FakeAIEngine()
    const handle = await engine.spawn("/tmp/x", "hi")
    const events: EngineEvent[] = [
      { type: "assistant.delta", text: "hello " },
      { type: "assistant.delta", text: "world" },
      { type: "done" },
    ]
    engine.script(handle.sessionId, events)

    const received: EngineEvent[] = []
    for await (const ev of engine.stream(handle)) received.push(ev)
    expect(received).toEqual(events)
  })

  test("stream wakes up when events arrive after the consumer started", async () => {
    const engine = new FakeAIEngine()
    const handle = await engine.spawn("/tmp/x", "hi")

    const received: EngineEvent[] = []
    const consume = (async () => {
      for await (const ev of engine.stream(handle)) received.push(ev)
    })()

    // Push events on the next microtask so the consumer is already
    // parked on `q.waiters`.
    await new Promise((r) => setTimeout(r, 10))
    engine.script(handle.sessionId, [{ type: "assistant.delta", text: "late" }])
    await new Promise((r) => setTimeout(r, 10))
    engine.script(handle.sessionId, [{ type: "done" }])

    await consume
    expect(received.map((e) => e.type)).toEqual(["assistant.delta", "done"])
  })

  test("stop() ends an in-flight stream", async () => {
    const engine = new FakeAIEngine()
    const handle = await engine.spawn("/tmp/x", "hi")

    const consume = (async () => {
      const out: EngineEvent[] = []
      for await (const ev of engine.stream(handle)) out.push(ev)
      return out
    })()

    await new Promise((r) => setTimeout(r, 10))
    await engine.stop(handle)

    const out = await consume
    expect(out).toEqual([])
  })

  test("readHistory returns pre-seeded messages", async () => {
    const engine = new FakeAIEngine()
    engine.setHistory("preset", [
      { role: "user", content: "ping", timestamp: "2026-05-08T00:00:00Z", sessionId: "preset" },
      { role: "assistant", content: "pong", timestamp: "2026-05-08T00:00:01Z", sessionId: "preset" },
    ])
    const msgs = await engine.readHistory("preset")
    expect(msgs).toHaveLength(2)
    expect(msgs[0]?.content).toBe("ping")
  })

  test("unknown sessions yield nothing once finished", async () => {
    const engine = new FakeAIEngine()
    const handle = await engine.spawn("/tmp/x", "hi")
    engine.finish(handle.sessionId)
    const out: EngineEvent[] = []
    for await (const ev of engine.stream(handle)) out.push(ev)
    expect(out).toEqual([])
  })
})
