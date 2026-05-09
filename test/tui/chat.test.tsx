/**
 * Wave 3 Stream G — chat state-machine unit tests.
 *
 * `store.ts` has zero Solid/opentui imports, so we can exercise it
 * directly under vitest's Node runtime. The full Chat component itself
 * uses opentui native bindings and is proved by the G3 behavior test
 * (`test/behavior/g3-chat.test.ts`); here we cover the pure invariants
 * that determine whether the chat shows the right text in the right
 * order.
 *
 * Why this is necessary even though we have a behavior test:
 *   - PTY-based behavior tests are slow and binary ("did it render or
 *     not"). State-machine bugs that only surface under specific event
 *     sequences (e.g. tool.start after a partial assistant turn) are
 *     much cheaper to catch here than to debug from a tmux capture.
 *   - The pivot history of this module — full message store → ephemeral
 *     inFlight → simple two-array — means the boundary between "what
 *     the store does" and "what the renderer derives" needs to be
 *     spelled out concretely. These tests are the spec.
 */

import { describe, expect, test } from "vitest"
import {
  type ChatState,
  applyEvent,
  createInitialState,
  pushDraftUser,
  pushSystemError,
  reset,
  setPast,
} from "../../src/tui/panes/chat/store.ts"
import type { EngineEvent, Message } from "../../src/types/engine.ts"

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function delta(text: string): EngineEvent {
  return { type: "assistant.delta", text }
}
function start(name: string, input: unknown = {}): EngineEvent {
  return { type: "tool.start", name, input }
}
function result(name: string, output: unknown = "ok"): EngineEvent {
  return { type: "tool.result", name, output }
}
function userMsg(content: unknown, ts = "2026-05-08T00:00:00.000Z"): Message {
  return { role: "user", content, timestamp: ts, sessionId: "s" }
}
function asstMsg(content: unknown, ts = "2026-05-08T00:00:01.000Z"): Message {
  return { role: "assistant", content, timestamp: ts, sessionId: "s" }
}

// ---------------------------------------------------------------------
// createInitialState — the empty / mounted shape
// ---------------------------------------------------------------------

describe("createInitialState", () => {
  test("returns empty arrays + non-streaming + no error/draft", () => {
    const s = createInitialState()
    expect(s.past).toEqual([])
    expect(s.live).toEqual([])
    expect(s.draftUser).toBeNull()
    expect(s.isStreaming).toBe(false)
    expect(s.error).toBeNull()
  })

  test("each call returns a fresh object (no shared references)", () => {
    const a = createInitialState()
    const b = createInitialState()
    expect(a).not.toBe(b)
    expect(a.past).not.toBe(b.past)
    expect(a.live).not.toBe(b.live)
  })

  test("reset() is an alias for createInitialState()", () => {
    const a = reset()
    const b = createInitialState()
    expect(a).toEqual(b)
  })
})

// ---------------------------------------------------------------------
// setPast — load history, clear ephemeral buffers
// ---------------------------------------------------------------------

describe("setPast", () => {
  test("replaces past with the given message list and clears live + draft", () => {
    let s = createInitialState()
    s = pushDraftUser(s, "ping")
    s = applyEvent(s, delta("partial"))
    expect(s.live).toHaveLength(1)
    expect(s.draftUser).not.toBeNull()

    const past = [userMsg("hello"), asstMsg("hi")]
    s = setPast(s, past)
    expect(s.past).toEqual(past)
    expect(s.live).toEqual([])
    expect(s.draftUser).toBeNull()
  })

  test("does NOT touch isStreaming or error (those are independent surfaces)", () => {
    let s = createInitialState()
    s = pushSystemError(s, "boom")
    s = { ...s, isStreaming: true }
    const past = [userMsg("hi")]
    s = setPast(s, past)
    expect(s.isStreaming).toBe(true)
    expect(s.error).toBe("boom")
  })
})

// ---------------------------------------------------------------------
// pushDraftUser — submit
// ---------------------------------------------------------------------

describe("pushDraftUser", () => {
  test("sets isStreaming=true, stamps draftUser, clears prior error", () => {
    const initial: ChatState = {
      ...createInitialState(),
      error: "old failure",
    }
    const s = pushDraftUser(initial, "hello world", "2026-05-08T01:00:00.000Z")
    expect(s.isStreaming).toBe(true)
    expect(s.error).toBeNull()
    expect(s.draftUser).toEqual({ text: "hello world", ts: "2026-05-08T01:00:00.000Z" })
  })

  test("does not touch past or live", () => {
    let s = createInitialState()
    const past = [userMsg("prior")]
    s = setPast(s, past)
    s = applyEvent(s, delta("trailing"))
    const before = s.live
    const after = pushDraftUser(s, "new")
    expect(after.past).toBe(s.past)
    expect(after.live).toBe(before)
  })

  test("uses Date.now()-derived ISO when ts omitted", () => {
    const s = pushDraftUser(createInitialState(), "hi")
    expect(s.draftUser?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})

// ---------------------------------------------------------------------
// applyEvent — invariants per event type
// ---------------------------------------------------------------------

describe("applyEvent — assistant.delta", () => {
  test("appends to live + sets isStreaming=true (defensive)", () => {
    let s = createInitialState()
    s = applyEvent(s, delta("Hello"))
    expect(s.live).toEqual([{ type: "assistant.delta", text: "Hello" }])
    expect(s.isStreaming).toBe(true)
  })

  test("multiple deltas accumulate in arrival order", () => {
    let s = createInitialState()
    s = pushDraftUser(s, "hi")
    s = applyEvent(s, delta("Hello"))
    s = applyEvent(s, delta(" "))
    s = applyEvent(s, delta("world"))
    expect(s.live.map((e) => (e.type === "assistant.delta" ? e.text : null))).toEqual(["Hello", " ", "world"])
  })
})

describe("applyEvent — tool.start / tool.result", () => {
  test("tool.start appends without changing isStreaming", () => {
    let s = pushDraftUser(createInitialState(), "go")
    const before = s.isStreaming
    s = applyEvent(s, start("Read", { file: "a.ts" }))
    expect(s.live).toHaveLength(1)
    expect(s.live[0]).toEqual({ type: "tool.start", name: "Read", input: { file: "a.ts" } })
    expect(s.isStreaming).toBe(before)
  })

  test("tool.result appends as a separate event (correlation is render-time)", () => {
    let s = pushDraftUser(createInitialState(), "go")
    s = applyEvent(s, start("Read"))
    s = applyEvent(s, result("Read", { content: "hi" }))
    expect(s.live).toHaveLength(2)
    // Both events are preserved in arrival order — the renderer pairs
    // them by walking the array.
    expect(s.live[0]?.type).toBe("tool.start")
    expect(s.live[1]?.type).toBe("tool.result")
  })

  test("interleaving deltas and tool calls preserves arrival order", () => {
    let s = pushDraftUser(createInitialState(), "go")
    s = applyEvent(s, delta("about to call "))
    s = applyEvent(s, start("Bash", { cmd: "ls" }))
    s = applyEvent(s, result("Bash", "a\nb"))
    s = applyEvent(s, delta("done"))
    const types = s.live.map((e) => e.type)
    expect(types).toEqual(["assistant.delta", "tool.start", "tool.result", "assistant.delta"])
  })
})

describe("applyEvent — usage / done / error", () => {
  test("usage is a no-op", () => {
    const s = createInitialState()
    const after = applyEvent(s, { type: "usage", input_tokens: 1, output_tokens: 2 })
    expect(after).toEqual(s)
  })

  test("done clears isStreaming but keeps live + past intact", () => {
    let s = pushDraftUser(createInitialState(), "go")
    s = applyEvent(s, delta("hello"))
    expect(s.isStreaming).toBe(true)
    const liveBefore = s.live
    s = applyEvent(s, { type: "done" })
    expect(s.isStreaming).toBe(false)
    // live preserved — the trailing assistant text stays on screen.
    expect(s.live).toBe(liveBefore)
  })

  test("error clears isStreaming and writes the error banner", () => {
    let s = pushDraftUser(createInitialState(), "go")
    s = applyEvent(s, { type: "error", message: "kaboom" })
    expect(s.isStreaming).toBe(false)
    expect(s.error).toBe("kaboom")
  })

  test("error preserves prior live events (so the user sees what came before)", () => {
    let s = pushDraftUser(createInitialState(), "go")
    s = applyEvent(s, delta("partial answer"))
    s = applyEvent(s, { type: "error", message: "rate-limited" })
    expect(s.live).toHaveLength(1)
    expect(s.live[0]?.type).toBe("assistant.delta")
  })
})

describe("applyEvent — purity", () => {
  test("never mutates the input state", () => {
    const s = createInitialState()
    const snapshot = JSON.stringify(s)
    applyEvent(s, delta("x"))
    applyEvent(s, start("Read"))
    applyEvent(s, { type: "done" })
    expect(JSON.stringify(s)).toBe(snapshot)
  })

  test("returns a new live array reference for events that touch it", () => {
    const s = createInitialState()
    const after = applyEvent(s, delta("x"))
    expect(after.live).not.toBe(s.live)
  })
})

// ---------------------------------------------------------------------
// pushSystemError — orchestrator-level failures
// ---------------------------------------------------------------------

describe("pushSystemError", () => {
  test("clears isStreaming + writes the error", () => {
    let s = pushDraftUser(createInitialState(), "go")
    s = pushSystemError(s, "runTask failed: boom")
    expect(s.isStreaming).toBe(false)
    expect(s.error).toBe("runTask failed: boom")
  })

  test("keeps draftUser + live so the user sees what they tried to send", () => {
    let s = createInitialState()
    s = pushDraftUser(s, "ping")
    s = applyEvent(s, delta("partial"))
    const before = { draftUser: s.draftUser, live: s.live }
    s = pushSystemError(s, "boom")
    expect(s.draftUser).toBe(before.draftUser)
    expect(s.live).toBe(before.live)
  })
})

// ---------------------------------------------------------------------
// Multi-turn / task-switch scenario tests — these exercise the
// invariants in plain English: "if a user has a turn, then submits
// again, then switches tasks, the state ends up where we expect."
// ---------------------------------------------------------------------

describe("integration scenarios", () => {
  test("happy-path single turn: submit → deltas → done", () => {
    let s = createInitialState()
    s = pushDraftUser(s, "hi")
    expect(s.isStreaming).toBe(true)
    expect(s.draftUser?.text).toBe("hi")

    s = applyEvent(s, delta("Hello"))
    s = applyEvent(s, delta(" world"))
    expect(s.isStreaming).toBe(true)
    expect(s.live).toHaveLength(2)

    s = applyEvent(s, { type: "done" })
    expect(s.isStreaming).toBe(false)
    // draftUser and live both still rendered — they get cleared on
    // the next task switch / setPast.
    expect(s.draftUser).not.toBeNull()
    expect(s.live).toHaveLength(2)
  })

  test("multi-turn: prior turn lingers in live until next setPast", () => {
    let s = createInitialState()
    s = pushDraftUser(s, "first")
    s = applyEvent(s, delta("answer one"))
    s = applyEvent(s, { type: "done" })

    // Second submit should set isStreaming again. Per the simplified
    // model, we don't mid-session re-read; live keeps growing.
    s = pushDraftUser(s, "second")
    expect(s.isStreaming).toBe(true)
    expect(s.error).toBeNull()
    s = applyEvent(s, delta("answer two"))
    s = applyEvent(s, { type: "done" })
    // live now has both turns' deltas, in order.
    expect(s.live.map((e) => (e.type === "assistant.delta" ? e.text : null)).filter(Boolean)).toEqual([
      "answer one",
      "answer two",
    ])
  })

  test("task switch: createInitialState → setPast wipes live + draftUser", () => {
    let s = createInitialState()
    s = pushDraftUser(s, "task A")
    s = applyEvent(s, delta("A reply"))

    // Simulate switch:
    s = createInitialState()
    expect(s.live).toEqual([])
    expect(s.draftUser).toBeNull()
    expect(s.past).toEqual([])

    // Then load history for task B:
    s = setPast(s, [userMsg("B prior"), asstMsg("B reply")])
    expect(s.past).toHaveLength(2)
    expect(s.live).toEqual([])
    expect(s.draftUser).toBeNull()
  })

  test("error mid-turn leaves prior deltas visible for review", () => {
    let s = createInitialState()
    s = pushDraftUser(s, "do thing")
    s = applyEvent(s, delta("starting…"))
    s = applyEvent(s, { type: "error", message: "context window full" })
    expect(s.error).toBe("context window full")
    expect(s.isStreaming).toBe(false)
    expect(s.live).toHaveLength(1)
    expect(s.draftUser?.text).toBe("do thing")
  })
})
