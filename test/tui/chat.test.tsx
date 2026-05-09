/**
 * Unit tests for `src/tui/panes/chat/store.ts`.
 *
 * The store is a single chronological-messages model. These tests pin
 * every behavior the renderer relies on:
 *   - createInitialState — empty messages, not streaming, no error.
 *   - setMessagesFromHistory — engine Message[] → ChatRow[].
 *   - pushUser — append a user row + flip isStreaming.
 *   - applyEvent — assistant.delta append/coalesce, tool start/result
 *     pairing, usage no-op, done flips streaming, error → system row.
 *   - pushSystemError — surface external errors.
 *   - Multi-turn integration: user prompts persist across turns
 *     (regression guard for the original draftUser-overwrite bug).
 */

import { describe, expect, test } from "vitest"
import {
  type ChatState,
  applyEvent,
  cleanChatText,
  createInitialState,
  pushSystemError,
  pushUser,
  reset,
  setMessagesFromHistory,
} from "../../src/tui/panes/chat/store.ts"
import type { EngineEvent, Message } from "../../src/types/engine.ts"

const FIXED_TS = "2026-05-09T00:00:00.000Z"

describe("createInitialState", () => {
  test("returns empty messages, not streaming, no error", () => {
    const s = createInitialState()
    expect(s.messages).toEqual([])
    expect(s.isStreaming).toBe(false)
    expect(s.error).toBeNull()
  })

  test("`reset` is an alias", () => {
    expect(reset()).toEqual(createInitialState())
  })
})

describe("setMessagesFromHistory", () => {
  test("converts user/assistant Messages to chronological ChatRows", () => {
    const past: Message[] = [
      { role: "user", content: "hi", timestamp: "2026-05-09T00:00:00Z", sessionId: "s" },
      { role: "assistant", content: "hello!", timestamp: "2026-05-09T00:00:01Z", sessionId: "s" },
      { role: "user", content: "how are you", timestamp: "2026-05-09T00:00:02Z", sessionId: "s" },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.messages).toHaveLength(3)
    expect(s.messages[0]).toEqual({ kind: "user", text: "hi", ts: "2026-05-09T00:00:00Z" })
    expect(s.messages[1]).toEqual({ kind: "assistant", text: "hello!", ts: "2026-05-09T00:00:01Z" })
    expect(s.messages[2]).toEqual({ kind: "user", text: "how are you", ts: "2026-05-09T00:00:02Z" })
  })

  test("extracts text blocks from array-shaped content", () => {
    const past: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
        ],
        timestamp: FIXED_TS,
        sessionId: "s",
      },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toEqual({ kind: "assistant", text: "hello world", ts: FIXED_TS })
  })

  test("renders tool_use blocks as collapsed tool rows", () => {
    const past: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "running ls" },
          { type: "tool_use", id: "tu_1", name: "Bash", input: { cmd: "ls" } },
        ],
        timestamp: FIXED_TS,
        sessionId: "s",
      },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.messages).toHaveLength(2)
    expect(s.messages[0]).toMatchObject({ kind: "assistant", text: "running ls" })
    expect(s.messages[1]).toMatchObject({
      kind: "tool",
      name: "Bash",
      input: { cmd: "ls" },
      done: false,
      toolUseId: "tu_1",
    })
  })

  test("pairs tool_result with its matching tool_use by id and marks it done", () => {
    const past: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { cmd: "ls" } }],
        timestamp: "2026-05-09T00:00:00Z",
        sessionId: "s",
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file1\nfile2" }],
        timestamp: "2026-05-09T00:00:01Z",
        sessionId: "s",
      },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    // No standalone user row for the message that only carried a tool_result.
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({
      kind: "tool",
      name: "Bash",
      done: true,
      output: "file1\nfile2",
      toolUseId: "tu_1",
    })
  })

  test("pairs tool_use ↔ tool_result correctly when same name fires twice in parallel", () => {
    // Two Bash calls; results arrive out-of-order. Name-only matching
    // would mismatch — id matching gets it right.
    const past: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_a", name: "Bash", input: { cmd: "first" } },
          { type: "tool_use", id: "tu_b", name: "Bash", input: { cmd: "second" } },
        ],
        timestamp: FIXED_TS,
        sessionId: "s",
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_b", content: "second-result" },
          { type: "tool_result", tool_use_id: "tu_a", content: "first-result" },
        ],
        timestamp: FIXED_TS,
        sessionId: "s",
      },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.messages).toHaveLength(2)
    expect(s.messages[0]).toMatchObject({ toolUseId: "tu_a", output: "first-result", done: true })
    expect(s.messages[1]).toMatchObject({ toolUseId: "tu_b", output: "second-result", done: true })
  })

  test("does not emit empty user/assistant rows for tool-only messages", () => {
    const past: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { path: "x" } }],
        timestamp: FIXED_TS,
        sessionId: "s",
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
        timestamp: FIXED_TS,
        sessionId: "s",
      },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.messages.filter((r) => r.kind === "user")).toHaveLength(0)
    expect(s.messages.filter((r) => r.kind === "assistant")).toHaveLength(0)
    expect(s.messages.filter((r) => r.kind === "tool")).toHaveLength(1)
  })

  test("orphan tool_result (no matching tool_use) renders as a standalone tool row", () => {
    const past: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "missing", content: "stranded" }],
        timestamp: FIXED_TS,
        sessionId: "s",
      },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({ kind: "tool", done: true, output: "stranded" })
  })

  test("drops thinking/unknown blocks silently", () => {
    const past: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning" },
          { type: "text", text: "answer" },
          { type: "image", source: { type: "base64", data: "..." } },
        ],
        timestamp: FIXED_TS,
        sessionId: "s",
      },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toEqual({ kind: "assistant", text: "answer", ts: FIXED_TS })
  })
})

describe("pushUser", () => {
  test("appends a user row + flips isStreaming on + clears error", () => {
    const start: ChatState = { ...createInitialState(), error: "old" }
    const s = pushUser(start, "hi", FIXED_TS)
    expect(s.messages).toEqual([{ kind: "user", text: "hi", ts: FIXED_TS }])
    expect(s.isStreaming).toBe(true)
    expect(s.error).toBeNull()
  })

  test("keeps prior history intact (does NOT overwrite earlier user rows)", () => {
    let s = pushUser(createInitialState(), "first", FIXED_TS)
    s = applyEvent(s, { type: "assistant.delta", text: "ok" }, FIXED_TS)
    s = applyEvent(s, { type: "done" }, FIXED_TS)
    s = pushUser(s, "second", FIXED_TS)
    expect(s.messages.filter((r) => r.kind === "user")).toHaveLength(2)
    expect(s.messages.map((r) => r.kind)).toEqual(["user", "assistant", "user"])
  })
})

describe("applyEvent — assistant.delta", () => {
  test("appends an assistant row when no prior assistant in trail", () => {
    const start = pushUser(createInitialState(), "hi", FIXED_TS)
    const s = applyEvent(start, { type: "assistant.delta", text: "hello" }, FIXED_TS)
    expect(s.messages).toHaveLength(2)
    expect(s.messages[1]).toEqual({ kind: "assistant", text: "hello", ts: FIXED_TS })
    expect(s.isStreaming).toBe(true)
  })

  test("coalesces consecutive deltas into one assistant row", () => {
    let s = pushUser(createInitialState(), "hi", FIXED_TS)
    s = applyEvent(s, { type: "assistant.delta", text: "Hel" }, FIXED_TS)
    s = applyEvent(s, { type: "assistant.delta", text: "lo " }, FIXED_TS)
    s = applyEvent(s, { type: "assistant.delta", text: "world" }, FIXED_TS)
    expect(s.messages.filter((r) => r.kind === "assistant")).toHaveLength(1)
    expect((s.messages[1] as { text: string }).text).toBe("Hello world")
  })

  test("does NOT coalesce across a tool boundary", () => {
    let s = pushUser(createInitialState(), "hi", FIXED_TS)
    s = applyEvent(s, { type: "assistant.delta", text: "first" }, FIXED_TS)
    s = applyEvent(s, { type: "tool.start", name: "Bash", input: { cmd: "ls" } }, FIXED_TS)
    s = applyEvent(s, { type: "assistant.delta", text: "second" }, FIXED_TS)
    expect(s.messages.filter((r) => r.kind === "assistant")).toHaveLength(2)
  })
})

describe("applyEvent — tool.start / tool.result", () => {
  test("tool.start appends an unfinished tool row", () => {
    const s = applyEvent(createInitialState(), { type: "tool.start", name: "Bash", input: { cmd: "ls" } }, FIXED_TS)
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({ kind: "tool", name: "Bash", done: false })
  })

  test("tool.result patches the most recent unfinished tool with same name", () => {
    let s = createInitialState()
    s = applyEvent(s, { type: "tool.start", name: "Bash", input: { cmd: "ls" } }, FIXED_TS)
    s = applyEvent(s, { type: "tool.result", name: "Bash", output: "ok" }, FIXED_TS)
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({ kind: "tool", name: "Bash", done: true, output: "ok" })
  })

  test("tool.result with no preceding start appends a standalone row", () => {
    const s = applyEvent(createInitialState(), { type: "tool.result", name: "Bash", output: "ok" }, FIXED_TS)
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({ kind: "tool", name: "Bash", done: true, input: undefined })
  })

  test("tool.result pairs with the LAST unfinished start of that name", () => {
    let s = createInitialState()
    s = applyEvent(s, { type: "tool.start", name: "Bash", input: 1 }, FIXED_TS)
    s = applyEvent(s, { type: "tool.start", name: "Bash", input: 2 }, FIXED_TS)
    s = applyEvent(s, { type: "tool.result", name: "Bash", output: "for-2" }, FIXED_TS)
    expect(s.messages).toHaveLength(2)
    expect(s.messages[0]).toMatchObject({ done: false, input: 1 })
    expect(s.messages[1]).toMatchObject({ done: true, input: 2, output: "for-2" })
  })
})

describe("applyEvent — usage / done / error", () => {
  test("usage is a no-op", () => {
    const start = pushUser(createInitialState(), "hi", FIXED_TS)
    const s = applyEvent(start, { type: "usage", input_tokens: 1, output_tokens: 2 }, FIXED_TS)
    expect(s.messages).toEqual(start.messages)
    expect(s.isStreaming).toBe(start.isStreaming)
  })

  test("done flips isStreaming off, leaves messages alone", () => {
    let s = pushUser(createInitialState(), "hi", FIXED_TS)
    s = applyEvent(s, { type: "assistant.delta", text: "ok" }, FIXED_TS)
    const before = s.messages
    s = applyEvent(s, { type: "done" }, FIXED_TS)
    expect(s.isStreaming).toBe(false)
    expect(s.messages).toEqual(before)
  })

  test("error appends a system row + sets banner + flips streaming off", () => {
    let s = pushUser(createInitialState(), "hi", FIXED_TS)
    s = applyEvent(s, { type: "error", message: "engine exploded" }, FIXED_TS)
    expect(s.isStreaming).toBe(false)
    expect(s.error).toBe("engine exploded")
    const last = s.messages[s.messages.length - 1]
    expect(last).toMatchObject({ kind: "system", text: "error: engine exploded" })
  })
})

describe("applyEvent — user.inject", () => {
  test("appends a user row, flips streaming on, clears error", () => {
    const start: ChatState = { ...createInitialState(), error: "stale" }
    const s = applyEvent(start, { type: "user.inject", text: "create a PR" }, FIXED_TS)
    expect(s.messages).toEqual([{ kind: "user", text: "create a PR", ts: FIXED_TS }])
    expect(s.isStreaming).toBe(true)
    expect(s.error).toBeNull()
  })

  test("preserves prior history (concatenates, does not overwrite)", () => {
    let s = pushUser(createInitialState(), "first", FIXED_TS)
    s = applyEvent(s, { type: "assistant.delta", text: "ok" }, FIXED_TS)
    s = applyEvent(s, { type: "done" }, FIXED_TS)
    s = applyEvent(s, { type: "user.inject", text: "Follow these steps to create a PR" }, FIXED_TS)
    expect(s.messages.map((r) => r.kind)).toEqual(["user", "assistant", "user"])
    expect((s.messages[2] as { text: string }).text).toContain("Follow these steps")
    expect(s.isStreaming).toBe(true)
  })
})

describe("applyEvent — purity", () => {
  test("does not mutate input state", () => {
    const start = createInitialState()
    const before = JSON.stringify(start)
    applyEvent(start, { type: "assistant.delta", text: "x" }, FIXED_TS)
    expect(JSON.stringify(start)).toBe(before)
  })
})

describe("pushSystemError", () => {
  test("appends a system row + banner + clears streaming", () => {
    let s = pushUser(createInitialState(), "hi", FIXED_TS)
    s = pushSystemError(s, "runTask failed!", FIXED_TS)
    expect(s.isStreaming).toBe(false)
    expect(s.error).toBe("runTask failed!")
    const last = s.messages[s.messages.length - 1]
    expect(last).toMatchObject({ kind: "system" })
    expect((last as { text: string }).text).toContain("runTask failed!")
  })
})

describe("integration scenarios", () => {
  test("multi-turn conversation preserves all user prompts", () => {
    let s = createInitialState()
    s = pushUser(s, "first", "2026-05-09T00:00:00Z")
    s = applyEvent(s, { type: "assistant.delta", text: "ok" } satisfies EngineEvent, "2026-05-09T00:00:01Z")
    s = applyEvent(s, { type: "done" } satisfies EngineEvent, "2026-05-09T00:00:02Z")
    s = pushUser(s, "second", "2026-05-09T00:00:03Z")
    s = applyEvent(s, { type: "assistant.delta", text: "ack" } satisfies EngineEvent, "2026-05-09T00:00:04Z")
    s = applyEvent(s, { type: "done" } satisfies EngineEvent, "2026-05-09T00:00:05Z")

    expect(s.messages.map((r) => r.kind)).toEqual(["user", "assistant", "user", "assistant"])
    expect((s.messages[0] as { text: string }).text).toBe("first")
    expect((s.messages[2] as { text: string }).text).toBe("second")
    expect(s.isStreaming).toBe(false)
  })

  test("history load + live events produce a single chronological list", () => {
    const past: Message[] = [
      { role: "user", content: "old user", timestamp: "2026-05-09T00:00:00Z", sessionId: "s" },
      { role: "assistant", content: "old assistant", timestamp: "2026-05-09T00:00:01Z", sessionId: "s" },
    ]
    let s = setMessagesFromHistory(createInitialState(), past)
    s = pushUser(s, "new prompt", "2026-05-09T00:01:00Z")
    s = applyEvent(s, { type: "assistant.delta", text: "new reply" }, "2026-05-09T00:01:01Z")
    s = applyEvent(s, { type: "done" }, "2026-05-09T00:01:02Z")

    expect(s.messages.map((r) => r.kind)).toEqual(["user", "assistant", "user", "assistant"])
    expect(s.messages[0]).toMatchObject({ text: "old user" })
    expect(s.messages[3]).toMatchObject({ text: "new reply" })
  })
})

describe("cleanChatText / noise filtering", () => {
  test("strips local-command-caveat blocks (the original symptom)", () => {
    const out = cleanChatText(
      "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>",
    )
    expect(out).toBe("")
  })

  test("strips known noise tags but keeps surrounding text", () => {
    const out = cleanChatText("hello <system-reminder>internal</system-reminder> world")
    expect(out).toBe("hello  world".trim())
  })

  test("leaves plain text alone (no allocation past the early-return)", () => {
    expect(cleanChatText("just regular text")).toBe("just regular text")
    expect(cleanChatText("")).toBe("")
  })

  test("history hydration drops user rows whose text is pure caveat", () => {
    const past: Message[] = [
      {
        role: "user",
        content:
          "<local-command-caveat>Caveat: don't respond.</local-command-caveat>",
        timestamp: FIXED_TS,
        sessionId: "s",
      },
      { role: "assistant", content: "real reply", timestamp: FIXED_TS, sessionId: "s" },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.messages.map((r) => r.kind)).toEqual(["assistant"])
    expect(s.messages[0]).toMatchObject({ text: "real reply" })
  })

  test("history hydration keeps user text after stripping a caveat block", () => {
    const past: Message[] = [
      {
        role: "user",
        content: "<local-command-caveat>noise</local-command-caveat>my real prompt",
        timestamp: FIXED_TS,
        sessionId: "s",
      },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({ kind: "user", text: "my real prompt" })
  })
})
