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
import { BASH_OUTPUT_COLLAPSED_CAP, readBashInput, splitBashOutput } from "../../src/tui/panes/chat/bash-render.ts"
import {
  COLLAPSED_LINE_CAP,
  capLines,
  formatEditDiff,
  formatMultiEditDiff,
  formatWriteDiff,
} from "../../src/tui/panes/chat/edit-diff.ts"
import {
  type ChatState,
  SCROLLBACK_CAP,
  applyEvent,
  cleanChatText,
  createInitialState,
  pushSystemError,
  pushUser,
  reset,
  setMessagesFromHistory,
} from "../../src/tui/panes/chat/store.ts"
import { summarizeGlob, summarizeGrep, summarizeRead } from "../../src/tui/panes/chat/tool-banners.ts"
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
        content: "<local-command-caveat>Caveat: don't respond.</local-command-caveat>",
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

describe("applyEvent — user_input request/resolved (ExitPlanMode)", () => {
  test("user_input.request appends a pending approval row, flips streaming off", () => {
    let s = createInitialState()
    s = pushUser(s, "do thing", FIXED_TS) // streaming = true
    s = applyEvent(
      s,
      {
        type: "user_input.request",
        requestId: "req-1",
        payload: { kind: "approve_plan", plan: "## Step 1", filePath: "/tmp/p.md" },
      },
      FIXED_TS,
    )
    const last = s.messages[s.messages.length - 1]
    expect(last).toMatchObject({
      kind: "approval",
      requestId: "req-1",
      tool: "ExitPlanMode",
      plan: "## Step 1",
      filePath: "/tmp/p.md",
      status: "pending",
    })
    expect(s.isStreaming).toBe(false)
  })

  test("user_input.resolved patches the matching pending approval row to approved", () => {
    let s = createInitialState()
    s = applyEvent(
      s,
      {
        type: "user_input.request",
        requestId: "req-1",
        payload: { kind: "approve_plan", plan: "p", filePath: null },
      },
      FIXED_TS,
    )
    s = applyEvent(
      s,
      { type: "user_input.resolved", requestId: "req-1", response: { kind: "approve_plan", approve: true } },
      FIXED_TS,
    )
    const last = s.messages[s.messages.length - 1]
    expect(last).toMatchObject({ kind: "approval", status: "approved" })
  })

  test("user_input.resolved marks rejected when approve=false", () => {
    let s = createInitialState()
    s = applyEvent(
      s,
      {
        type: "user_input.request",
        requestId: "req-1",
        payload: { kind: "approve_plan", plan: "p", filePath: null },
      },
      FIXED_TS,
    )
    s = applyEvent(
      s,
      { type: "user_input.resolved", requestId: "req-1", response: { kind: "approve_plan", approve: false } },
      FIXED_TS,
    )
    expect(s.messages[s.messages.length - 1]).toMatchObject({ kind: "approval", status: "rejected" })
  })

  test("user_input.resolved with no matching pending row is a no-op (re-click race)", () => {
    let s = createInitialState()
    s = applyEvent(
      s,
      {
        type: "user_input.request",
        requestId: "req-1",
        payload: { kind: "approve_plan", plan: "p", filePath: null },
      },
      FIXED_TS,
    )
    // First resolve patches it.
    s = applyEvent(
      s,
      { type: "user_input.resolved", requestId: "req-1", response: { kind: "approve_plan", approve: true } },
      FIXED_TS,
    )
    // Second resolve should not mutate (no longer pending).
    const before = s.messages.length
    s = applyEvent(
      s,
      { type: "user_input.resolved", requestId: "req-1", response: { kind: "approve_plan", approve: false } },
      FIXED_TS,
    )
    expect(s.messages).toHaveLength(before)
    expect(s.messages[s.messages.length - 1]).toMatchObject({ status: "approved" })
  })
})

describe("applyEvent — user_input request/resolved (AskUserQuestion)", () => {
  test("user_input.request appends a pending question row, flips streaming off", () => {
    let s = createInitialState()
    s = applyEvent(
      s,
      {
        type: "user_input.request",
        requestId: "q-1",
        payload: {
          kind: "ask_question",
          questions: [
            {
              question: "Pick one?",
              header: "Choice",
              multiSelect: false,
              options: [
                { label: "A", description: "first" },
                { label: "B", description: "second" },
              ],
            },
          ],
        },
      },
      FIXED_TS,
    )
    const last = s.messages[s.messages.length - 1]
    expect(last).toMatchObject({
      kind: "question",
      requestId: "q-1",
      answers: null,
    })
    expect((last as unknown as { questions: unknown[] }).questions).toHaveLength(1)
    expect(s.isStreaming).toBe(false)
  })

  test("user_input.resolved patches the matching pending question row with answers", () => {
    let s = createInitialState()
    s = applyEvent(
      s,
      {
        type: "user_input.request",
        requestId: "q-1",
        payload: {
          kind: "ask_question",
          questions: [
            {
              question: "Pick one?",
              header: "",
              multiSelect: false,
              options: [{ label: "A", description: "" }],
            },
          ],
        },
      },
      FIXED_TS,
    )
    s = applyEvent(
      s,
      {
        type: "user_input.resolved",
        requestId: "q-1",
        response: { kind: "ask_question", answers: { "Pick one?": "A" } },
      },
      FIXED_TS,
    )
    const last = s.messages[s.messages.length - 1]
    expect(last).toMatchObject({
      kind: "question",
      answers: { "Pick one?": "A" },
    })
  })

  test("kind mismatch (approve_plan response on question row) leaves row pending", () => {
    let s = createInitialState()
    s = applyEvent(
      s,
      {
        type: "user_input.request",
        requestId: "q-1",
        payload: {
          kind: "ask_question",
          questions: [
            {
              question: "?",
              header: "",
              multiSelect: false,
              options: [{ label: "A", description: "" }],
            },
          ],
        },
      },
      FIXED_TS,
    )
    s = applyEvent(
      s,
      { type: "user_input.resolved", requestId: "q-1", response: { kind: "approve_plan", approve: true } },
      FIXED_TS,
    )
    expect(s.messages[s.messages.length - 1]).toMatchObject({ kind: "question", answers: null })
  })
})

/* ----------------------------------------------------------------- */
/*  edit-diff helpers — inline Edit/Write diff formatting             */
/*  (rendered by ToolRow's EditWriteDiffBlock; lifted from upstream   */
/*  refs/claude-code/src/components/FileEditToolUpdatedMessage.tsx).  */
/* ----------------------------------------------------------------- */

describe("formatEditDiff", () => {
  test("splits old_string and new_string into per-line removes/adds", () => {
    const out = formatEditDiff({
      file_path: "/abs/foo.ts",
      old_string: "alpha\nbeta",
      new_string: "alpha\nGAMMA\nbeta",
    })
    expect(out.removes).toEqual(["alpha", "beta"])
    expect(out.adds).toEqual(["alpha", "GAMMA", "beta"])
  })

  test("header includes the file path + Added/removed line counts", () => {
    const out = formatEditDiff({
      file_path: "/abs/foo.ts",
      old_string: "x",
      new_string: "x\ny\nz",
    })
    expect(out.header).toContain("/abs/foo.ts")
    expect(out.header).toContain("Added 3 lines")
    expect(out.header).toContain("removed 1 line")
  })

  test("header pluralises 1-line edits singularly", () => {
    const out = formatEditDiff({
      file_path: "/abs/foo.ts",
      old_string: "old",
      new_string: "new",
    })
    // Negative lookahead, NOT [^s] — the header ends right after "1 line"
    // and end-of-string doesn't match `[^s]`.
    expect(out.header).toMatch(/Added 1 line(?!s)/)
    expect(out.header).toMatch(/removed 1 line(?!s)/)
  })

  test("falls back to placeholder header when file_path missing", () => {
    const out = formatEditDiff({ old_string: "x", new_string: "y" })
    expect(out.header).toContain("(unknown file)")
  })

  test("CRLF newlines split correctly so Windows-saved input still diffs", () => {
    const out = formatEditDiff({
      file_path: "/p",
      old_string: "a\r\nb",
      new_string: "a\r\nB",
    })
    expect(out.removes).toEqual(["a", "b"])
    expect(out.adds).toEqual(["a", "B"])
  })

  test("non-string fields collapse to empty diff (no crash)", () => {
    const out = formatEditDiff({ file_path: 42, old_string: null, new_string: undefined })
    expect(out.removes).toEqual([])
    expect(out.adds).toEqual([])
    expect(out.header).toContain("(unknown file)")
  })

  test("non-object input collapses to an empty diff", () => {
    const out = formatEditDiff(null)
    expect(out.removes).toEqual([])
    expect(out.adds).toEqual([])
  })
})

describe("formatWriteDiff", () => {
  test("renders content as additions only (no removes)", () => {
    const out = formatWriteDiff({
      file_path: "/abs/new.ts",
      content: "line one\nline two\nline three",
    })
    expect(out.removes).toEqual([])
    expect(out.adds).toEqual(["line one", "line two", "line three"])
  })

  test("header reads as a Wrote-N-lines summary", () => {
    const out = formatWriteDiff({
      file_path: "/abs/new.ts",
      content: "only line",
    })
    expect(out.header).toContain("Wrote")
    expect(out.header).toContain("/abs/new.ts")
    expect(out.header).toContain("Added 1 line")
  })

  test("empty content produces a 0-line diff (no add rows)", () => {
    const out = formatWriteDiff({ file_path: "/p", content: "" })
    expect(out.adds).toEqual([])
    expect(out.removes).toEqual([])
    // Header still mentions the file so the row is identifiable.
    expect(out.header).toContain("/p")
  })
})

describe("capLines", () => {
  test("returns full list when under cap", () => {
    const out = capLines(["a", "b"], 5)
    expect(out.visible).toEqual(["a", "b"])
    expect(out.hidden).toBe(0)
  })

  test("truncates and reports hidden count", () => {
    const out = capLines(["1", "2", "3", "4", "5"], 2)
    expect(out.visible).toEqual(["1", "2"])
    expect(out.hidden).toBe(3)
  })

  test("negative cap means uncapped (used by expanded view)", () => {
    const out = capLines(["a", "b", "c"], -1)
    expect(out.visible).toEqual(["a", "b", "c"])
    expect(out.hidden).toBe(0)
  })

  test("COLLAPSED_LINE_CAP is exported for the renderer", () => {
    expect(COLLAPSED_LINE_CAP).toBeGreaterThan(0)
    // Sanity: cap is small enough that a typical multi-hunk Edit is
    // visibly truncated, large enough that a single-line tweak shows
    // both sides without the "… N more lines" tail.
    expect(COLLAPSED_LINE_CAP).toBeLessThan(50)
  })

  test("renderer collapsed-mode integration: long Edit caps + reports", () => {
    const big = Array.from({ length: COLLAPSED_LINE_CAP + 5 }, (_, i) => `line ${i}`).join("\n")
    const diff = formatEditDiff({
      file_path: "/big.ts",
      old_string: big,
      new_string: big.replace("line 0", "LINE 0"),
    })
    const collapsed = capLines(diff.removes, COLLAPSED_LINE_CAP)
    expect(collapsed.visible).toHaveLength(COLLAPSED_LINE_CAP)
    expect(collapsed.hidden).toBe(5)
  })
})

/* ----------------------------------------------------------------- */
/*  edit-diff helpers — inline Edit/Write diff formatting             */
/*  (rendered by ToolRow's EditWriteDiffBlock; lifted from upstream   */
/*  refs/claude-code/src/components/FileEditToolUpdatedMessage.tsx).  */
/* ----------------------------------------------------------------- */

describe("formatEditDiff", () => {
  test("splits old_string and new_string into per-line removes/adds", () => {
    const out = formatEditDiff({
      file_path: "/abs/foo.ts",
      old_string: "alpha\nbeta",
      new_string: "alpha\nGAMMA\nbeta",
    })
    expect(out.removes).toEqual(["alpha", "beta"])
    expect(out.adds).toEqual(["alpha", "GAMMA", "beta"])
  })

  test("header includes the file path + Added/removed line counts", () => {
    const out = formatEditDiff({
      file_path: "/abs/foo.ts",
      old_string: "x",
      new_string: "x\ny\nz",
    })
    expect(out.header).toContain("/abs/foo.ts")
    expect(out.header).toContain("Added 3 lines")
    expect(out.header).toContain("removed 1 line")
  })

  test("header pluralises 1-line edits singularly", () => {
    const out = formatEditDiff({
      file_path: "/abs/foo.ts",
      old_string: "old",
      new_string: "new",
    })
    // Negative lookahead, NOT [^s] — the header ends right after "1 line"
    // and end-of-string doesn't match `[^s]`.
    expect(out.header).toMatch(/Added 1 line(?!s)/)
    expect(out.header).toMatch(/removed 1 line(?!s)/)
  })

  test("falls back to placeholder header when file_path missing", () => {
    const out = formatEditDiff({ old_string: "x", new_string: "y" })
    expect(out.header).toContain("(unknown file)")
  })

  test("CRLF newlines split correctly so Windows-saved input still diffs", () => {
    const out = formatEditDiff({
      file_path: "/p",
      old_string: "a\r\nb",
      new_string: "a\r\nB",
    })
    expect(out.removes).toEqual(["a", "b"])
    expect(out.adds).toEqual(["a", "B"])
  })

  test("non-string fields collapse to empty diff (no crash)", () => {
    const out = formatEditDiff({ file_path: 42, old_string: null, new_string: undefined })
    expect(out.removes).toEqual([])
    expect(out.adds).toEqual([])
    expect(out.header).toContain("(unknown file)")
  })

  test("non-object input collapses to an empty diff", () => {
    const out = formatEditDiff(null)
    expect(out.removes).toEqual([])
    expect(out.adds).toEqual([])
  })
})

describe("formatWriteDiff", () => {
  test("renders content as additions only (no removes)", () => {
    const out = formatWriteDiff({
      file_path: "/abs/new.ts",
      content: "line one\nline two\nline three",
    })
    expect(out.removes).toEqual([])
    expect(out.adds).toEqual(["line one", "line two", "line three"])
  })

  test("header reads as a Wrote-N-lines summary", () => {
    const out = formatWriteDiff({
      file_path: "/abs/new.ts",
      content: "only line",
    })
    expect(out.header).toContain("Wrote")
    expect(out.header).toContain("/abs/new.ts")
    expect(out.header).toContain("Added 1 line")
  })

  test("empty content produces a 0-line diff (no add rows)", () => {
    const out = formatWriteDiff({ file_path: "/p", content: "" })
    expect(out.adds).toEqual([])
    expect(out.removes).toEqual([])
    // Header still mentions the file so the row is identifiable.
    expect(out.header).toContain("/p")
  })
})

describe("capLines", () => {
  test("returns full list when under cap", () => {
    const out = capLines(["a", "b"], 5)
    expect(out.visible).toEqual(["a", "b"])
    expect(out.hidden).toBe(0)
  })

  test("truncates and reports hidden count", () => {
    const out = capLines(["1", "2", "3", "4", "5"], 2)
    expect(out.visible).toEqual(["1", "2"])
    expect(out.hidden).toBe(3)
  })

  test("negative cap means uncapped (used by expanded view)", () => {
    const out = capLines(["a", "b", "c"], -1)
    expect(out.visible).toEqual(["a", "b", "c"])
    expect(out.hidden).toBe(0)
  })

  test("COLLAPSED_LINE_CAP is exported for the renderer", () => {
    expect(COLLAPSED_LINE_CAP).toBeGreaterThan(0)
    // Sanity: cap is small enough that a typical multi-hunk Edit is
    // visibly truncated, large enough that a single-line tweak shows
    // both sides without the "… N more lines" tail.
    expect(COLLAPSED_LINE_CAP).toBeLessThan(50)
  })

  test("renderer collapsed-mode integration: long Edit caps + reports", () => {
    const big = Array.from({ length: COLLAPSED_LINE_CAP + 5 }, (_, i) => `line ${i}`).join("\n")
    const diff = formatEditDiff({
      file_path: "/big.ts",
      old_string: big,
      new_string: big.replace("line 0", "LINE 0"),
    })
    const collapsed = capLines(diff.removes, COLLAPSED_LINE_CAP)
    expect(collapsed.visible).toHaveLength(COLLAPSED_LINE_CAP)
    expect(collapsed.hidden).toBe(5)
  })
})

/* --------------------------------------------------------------------- */
/*  Bounded scrollback                                                    */
/* --------------------------------------------------------------------- */

/**
 * The chat store keeps a per-tab `messages: ChatRow[]` array. Without a
 * cap, a long-running streaming session would balloon RSS — the perf
 * baseline (`docs/perf/baseline.md`) measured ~168 MB over a 1000-event
 * burst. These tests pin the bound:
 *
 *   - `SCROLLBACK_CAP` is never exceeded after many appends.
 *   - A single sentinel system row appears at index 0 once the cap is
 *     crossed.
 *   - Re-truncation coalesces — no stacked sentinels; the count bumps.
 *   - The trailing assistant row that's mid-stream (coalescing via
 *     `assistant.delta`) is preserved across truncations.
 *   - History hydration with > cap rows yields a capped state with
 *     the right sentinel.
 */
describe("bounded scrollback", () => {
  // tool.start adds a fresh row each time → easiest way to push the
  // array length up without triggering the assistant.delta coalesce
  // path (which doesn't grow the array).
  const fillToolStarts = (s: ChatState, n: number): ChatState => {
    let cur = s
    for (let i = 0; i < n; i++) {
      cur = applyEvent(cur, { type: "tool.start", name: "Bash", input: { i } }, FIXED_TS)
    }
    return cur
  }

  test("never exceeds SCROLLBACK_CAP after many appends", () => {
    const s = fillToolStarts(createInitialState(), SCROLLBACK_CAP * 3)
    expect(s.messages.length).toBe(SCROLLBACK_CAP)
  })

  test("sentinel system row appears at index 0 once cap is exceeded", () => {
    // Pushing CAP+5 rows drops 6 from the front: 5 overflow + 1 slot
    // reserved for the sentinel itself (cap = sentinel + cap-1 content).
    const s = fillToolStarts(createInitialState(), SCROLLBACK_CAP + 5)
    const head = s.messages[0]
    expect(head?.kind).toBe("system")
    expect((head as { text: string }).text).toMatch(/scrollback truncated/)
    expect((head as { text: string }).text).toMatch(/6 rows dropped/)
  })

  test("assistant.delta coalesce path doesn't grow the array, so doesn't trigger truncation", () => {
    // Fill exactly to the cap with tool starts, then push a single
    // assistant row. Subsequent deltas should merge into it without
    // pushing the array over the cap.
    let s = fillToolStarts(createInitialState(), SCROLLBACK_CAP - 1)
    s = applyEvent(s, { type: "assistant.delta", text: "a" }, FIXED_TS)
    expect(s.messages.length).toBe(SCROLLBACK_CAP)
    s = applyEvent(s, { type: "assistant.delta", text: "b" }, FIXED_TS)
    s = applyEvent(s, { type: "assistant.delta", text: "c" }, FIXED_TS)
    // Length is unchanged — the delta merged into the trailing row.
    expect(s.messages.length).toBe(SCROLLBACK_CAP)
    const last = s.messages[s.messages.length - 1]
    expect(last).toMatchObject({ kind: "assistant", text: "abc" })
  })

  test("sentinel coalesces across multiple truncations (count bumps, no stacking)", () => {
    // First overflow: push CAP+10 → drops 11 (10 overflow + 1 sentinel slot).
    let s = fillToolStarts(createInitialState(), SCROLLBACK_CAP + 10)
    expect(s.messages.length).toBe(SCROLLBACK_CAP)
    expect((s.messages[0] as { text: string }).text).toMatch(/11 rows dropped/)
    // Push 20 more rows. Each push above the cap drops one front content
    // row; the sentinel is preserved and its count bumps by 1 each time
    // (the old sentinel slot itself is reused, not double-counted).
    s = fillToolStarts(s, 20)
    expect(s.messages.length).toBe(SCROLLBACK_CAP)
    // Exactly one system row at the head; no second sentinel sneaked in.
    const sentinelRows = s.messages.filter(
      (r) => r.kind === "system" && /scrollback truncated/.test((r as { text: string }).text),
    )
    expect(sentinelRows).toHaveLength(1)
    // 11 from the first overflow + 20 added rows that each evicted one
    // content row = 31.
    expect((s.messages[0] as { text: string }).text).toMatch(/31 rows dropped/)
  })

  test("mid-stream live assistant row is preserved across truncation", () => {
    // Set up: push cap-1 tool starts, then start an assistant row.
    // Now any further append bumps the array over the cap and triggers
    // truncation — but the live tail (the assistant row) must survive
    // because it's still being coalesced into.
    let s = fillToolStarts(createInitialState(), SCROLLBACK_CAP - 1)
    s = applyEvent(s, { type: "assistant.delta", text: "live-" }, FIXED_TS)
    expect(s.messages.length).toBe(SCROLLBACK_CAP)
    const liveBefore = s.messages[s.messages.length - 1]
    expect(liveBefore).toMatchObject({ kind: "assistant" })
    // Coalesce more deltas — confirms the live row stays put.
    s = applyEvent(s, { type: "assistant.delta", text: "still-" }, FIXED_TS)
    s = applyEvent(s, { type: "assistant.delta", text: "alive" }, FIXED_TS)
    const liveAfter = s.messages[s.messages.length - 1]
    expect(liveAfter).toMatchObject({ kind: "assistant", text: "live-still-alive" })
    // Now push another *new* row to force a truncation. The previous
    // live assistant is no longer at the tail — but it survives because
    // we drop from the front, never the tail.
    s = applyEvent(s, { type: "tool.start", name: "Bash", input: 99 }, FIXED_TS)
    expect(s.messages.length).toBe(SCROLLBACK_CAP)
    // The assistant row containing "live-still-alive" is still present
    // (not dropped from the front of the cap window).
    const survived = s.messages.find(
      (r) => r.kind === "assistant" && (r as { text: string }).text === "live-still-alive",
    )
    expect(survived).toBeDefined()
  })

  test("setMessagesFromHistory caps a > cap history with the right sentinel", () => {
    // Build cap+25 trivial messages and hydrate.
    const past: Message[] = Array.from({ length: SCROLLBACK_CAP + 25 }, (_, i) => ({
      role: "user",
      content: `m${i}`,
      timestamp: FIXED_TS,
      sessionId: "s",
    }))
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.messages.length).toBe(SCROLLBACK_CAP)
    const head = s.messages[0]
    expect(head?.kind).toBe("system")
    // CAP+25 in → drops 26 (25 overflow + 1 sentinel slot).
    expect((head as { text: string }).text).toMatch(/26 rows dropped/)
    // The most recent rows survived (we keep the tail of history).
    const last = s.messages[s.messages.length - 1]
    expect(last).toMatchObject({ kind: "user", text: `m${SCROLLBACK_CAP + 25 - 1}` })
  })

  test("under-cap appends do not insert a sentinel", () => {
    const s = fillToolStarts(createInitialState(), SCROLLBACK_CAP - 5)
    expect(s.messages.length).toBe(SCROLLBACK_CAP - 5)
    // No system rows synthesized.
    expect(s.messages.filter((r) => r.kind === "system")).toHaveLength(0)
  })

  test("pushUser respects the cap", () => {
    let s = fillToolStarts(createInitialState(), SCROLLBACK_CAP)
    s = pushUser(s, "new prompt", FIXED_TS)
    expect(s.messages.length).toBe(SCROLLBACK_CAP)
    // Newest user prompt survives at the tail.
    expect(s.messages[s.messages.length - 1]).toMatchObject({ kind: "user", text: "new prompt" })
  })

  test("pushSystemError respects the cap", () => {
    let s = fillToolStarts(createInitialState(), SCROLLBACK_CAP)
    s = pushSystemError(s, "boom", FIXED_TS)
    expect(s.messages.length).toBe(SCROLLBACK_CAP)
    expect(s.messages[s.messages.length - 1]).toMatchObject({ kind: "system" })
  })
})

/* --------------------------------------------------------------------- */
/*  MultiEdit diff helper — `formatMultiEditDiff`                         */
/*  Lifted shape: refs/claude-code/src/components/messages/               */
/*    MultiEditToolUseMessage.tsx                                         */
/* --------------------------------------------------------------------- */

describe("formatMultiEditDiff", () => {
  test("emits one {removes, adds} pair per edit, in declared order", () => {
    const out = formatMultiEditDiff({
      file_path: "/abs/foo.ts",
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "beta\ngamma", new_string: "BETA\nGAMMA\nDELTA" },
      ],
    })
    expect(out.edits).toHaveLength(2)
    expect(out.edits[0]).toEqual({ removes: ["alpha"], adds: ["ALPHA"] })
    expect(out.edits[1]).toEqual({
      removes: ["beta", "gamma"],
      adds: ["BETA", "GAMMA", "DELTA"],
    })
  })

  test("header includes file path, edit count, and total add/remove counts", () => {
    const out = formatMultiEditDiff({
      file_path: "/abs/foo.ts",
      edits: [
        { old_string: "x", new_string: "x\ny" },
        { old_string: "z", new_string: "" },
      ],
    })
    expect(out.header).toContain("/abs/foo.ts")
    expect(out.header).toContain("2 edits")
    expect(out.header).toContain("Added 2 lines")
    expect(out.header).toContain("removed 2 lines")
  })

  test("singular edit count drops the plural", () => {
    const out = formatMultiEditDiff({
      file_path: "/p",
      edits: [{ old_string: "a", new_string: "b" }],
    })
    expect(out.header).toMatch(/1 edit(?!s)/)
  })

  test("zero edits — header still mentions the file but no counts", () => {
    const out = formatMultiEditDiff({ file_path: "/p", edits: [] })
    expect(out.header).toBe("Edited /p")
    expect(out.edits).toEqual([])
  })

  test("missing file_path falls back to placeholder", () => {
    const out = formatMultiEditDiff({ edits: [{ old_string: "a", new_string: "b" }] })
    expect(out.header).toContain("(unknown file)")
  })

  test("non-object input collapses to empty diff (no crash)", () => {
    const out = formatMultiEditDiff(null)
    expect(out.header).toContain("(unknown file)")
    expect(out.edits).toEqual([])
  })

  test("malformed edit entries in the array become empty pairs", () => {
    const out = formatMultiEditDiff({
      file_path: "/p",
      edits: [{ old_string: "a", new_string: "b" }, null, "garbage", { foo: "bar" }],
    })
    expect(out.edits).toHaveLength(4)
    expect(out.edits[0]).toEqual({ removes: ["a"], adds: ["b"] })
    expect(out.edits[1]).toEqual({ removes: [], adds: [] })
    expect(out.edits[2]).toEqual({ removes: [], adds: [] })
    expect(out.edits[3]).toEqual({ removes: [], adds: [] })
  })

  test("CRLF newlines split correctly on each edit's strings", () => {
    const out = formatMultiEditDiff({
      file_path: "/p",
      edits: [{ old_string: "a\r\nb", new_string: "a\r\nB" }],
    })
    expect(out.edits[0]?.removes).toEqual(["a", "b"])
    expect(out.edits[0]?.adds).toEqual(["a", "B"])
  })
})

/* --------------------------------------------------------------------- */
/*  Bash render helpers — `readBashInput`, `splitBashOutput`              */
/*  Lifted shape: refs/claude-code/src/components/messages/               */
/*    BashToolUseMessage.tsx                                              */
/* --------------------------------------------------------------------- */

describe("readBashInput", () => {
  test("returns command + description from a well-formed input", () => {
    expect(readBashInput({ command: "ls -la", description: "list files" })).toEqual({
      command: "ls -la",
      description: "list files",
    })
  })

  test("missing description defaults to empty string", () => {
    expect(readBashInput({ command: "pwd" })).toEqual({ command: "pwd", description: "" })
  })

  test("non-object input collapses to empty fields", () => {
    expect(readBashInput(null)).toEqual({ command: "", description: "" })
    expect(readBashInput("ls")).toEqual({ command: "", description: "" })
  })

  test("non-string command/description fields collapse to empty", () => {
    expect(readBashInput({ command: 42, description: { foo: "bar" } })).toEqual({
      command: "",
      description: "",
    })
  })
})

describe("splitBashOutput", () => {
  test("returns full lines when under the cap", () => {
    const out = splitBashOutput("a\nb\nc")
    expect(out.totalLines).toBe(3)
    expect(out.visible).toEqual(["a", "b", "c"])
    expect(out.hidden).toBe(0)
  })

  test("truncates to the cap and reports hidden count", () => {
    const text = Array.from({ length: BASH_OUTPUT_COLLAPSED_CAP + 5 }, (_, i) => `L${i}`).join("\n")
    const out = splitBashOutput(text)
    expect(out.totalLines).toBe(BASH_OUTPUT_COLLAPSED_CAP + 5)
    expect(out.visible).toHaveLength(BASH_OUTPUT_COLLAPSED_CAP)
    expect(out.hidden).toBe(5)
  })

  test("cap < 0 means no truncation (expanded view)", () => {
    const text = Array.from({ length: 50 }, (_, i) => `L${i}`).join("\n")
    const out = splitBashOutput(text, -1)
    expect(out.visible).toHaveLength(50)
    expect(out.hidden).toBe(0)
  })

  test("trailing newline is trimmed so no phantom empty row appears", () => {
    const out = splitBashOutput("a\nb\n")
    expect(out.totalLines).toBe(2)
    expect(out.visible).toEqual(["a", "b"])
  })

  test("CRLF newlines are accepted", () => {
    const out = splitBashOutput("a\r\nb\r\nc")
    expect(out.visible).toEqual(["a", "b", "c"])
  })

  test("empty / nullish output yields zero-line view (no crash)", () => {
    expect(splitBashOutput("")).toEqual({ totalLines: 0, visible: [], hidden: 0 })
    expect(splitBashOutput(null)).toEqual({ totalLines: 0, visible: [], hidden: 0 })
    expect(splitBashOutput(undefined)).toEqual({ totalLines: 0, visible: [], hidden: 0 })
  })

  test("non-string output (e.g. structured tool result) is JSON-stringified", () => {
    const out = splitBashOutput({ exitCode: 0, stdout: "ok" })
    expect(out.totalLines).toBeGreaterThan(0)
    expect(out.visible.join("\n")).toContain("exitCode")
  })
})

/* --------------------------------------------------------------------- */
/*  Read / Grep / Glob banner formatters                                  */
/*  Lifted shape: refs/claude-code/src/components/messages/               */
/*    {Read,Grep,Glob}ToolUseMessage.tsx                                  */
/* --------------------------------------------------------------------- */

describe("summarizeRead", () => {
  test("file_path only — no range suffix", () => {
    expect(summarizeRead({ file_path: "/abs/foo.ts" })).toBe("/abs/foo.ts")
  })

  test("file_path + offset + limit — explicit L<start>-<end>", () => {
    expect(summarizeRead({ file_path: "/abs/foo.ts", offset: 10, limit: 20 })).toBe("/abs/foo.ts · L10-30")
  })

  test("file_path + limit only — implicit L1-<limit>", () => {
    expect(summarizeRead({ file_path: "/p", limit: 50 })).toBe("/p · L1-50")
  })

  test("file_path + offset only — open-ended range", () => {
    expect(summarizeRead({ file_path: "/p", offset: 5 })).toBe("/p · L5-")
  })

  test("missing file_path falls back to placeholder", () => {
    expect(summarizeRead({})).toBe("(unknown file)")
  })

  test("non-object input does not crash", () => {
    expect(summarizeRead(null)).toBe("(unknown file)")
  })
})

describe("summarizeGrep", () => {
  test("in-flight render shows (searching…)", () => {
    expect(summarizeGrep({ pattern: "TODO" }, undefined, false)).toBe('"TODO" · (searching…)')
  })

  test("structured 'Found N files' output is parsed", () => {
    expect(summarizeGrep({ pattern: "x" }, "Found 3 files\n/a\n/b\n/c", true)).toBe('"x" · 3 files')
  })

  test("structured 'Found N matches' output is parsed", () => {
    expect(summarizeGrep({ pattern: "x" }, "Found 7 matches", true)).toBe('"x" · 7 matches')
  })

  test("singular form when count is 1", () => {
    expect(summarizeGrep({ pattern: "x" }, "Found 1 file", true)).toBe('"x" · 1 file')
    expect(summarizeGrep({ pattern: "x" }, "Found 1 match", true)).toBe('"x" · 1 match')
  })

  test("falls back to non-empty line count when output is unstructured", () => {
    expect(summarizeGrep({ pattern: "x" }, "/a:1:hit\n/b:2:hit\n/c:3:hit", true)).toBe('"x" · 3 matches')
  })

  test("empty/missing output reports 0 matches when done", () => {
    expect(summarizeGrep({ pattern: "x" }, "", true)).toBe('"x" · 0 matches')
    expect(summarizeGrep({ pattern: "x" }, undefined, true)).toBe('"x" · 0 matches')
  })

  test("missing pattern shows placeholder", () => {
    expect(summarizeGrep({}, "Found 1 file", true)).toBe("(no pattern) · 1 file")
  })
})

describe("summarizeGlob", () => {
  test("in-flight render shows (searching…)", () => {
    expect(summarizeGlob({ pattern: "**/*.ts" }, undefined, false)).toBe('"**/*.ts" · (searching…)')
  })

  test("counts non-empty lines as files", () => {
    expect(summarizeGlob({ pattern: "*.ts" }, "/a.ts\n/b.ts", true)).toBe('"*.ts" · 2 files')
  })

  test("singular form when count is 1", () => {
    expect(summarizeGlob({ pattern: "*.ts" }, "/only.ts", true)).toBe('"*.ts" · 1 file')
  })

  test("'No files found' style output reports 0 files", () => {
    expect(summarizeGlob({ pattern: "*.xyz" }, "No files found", true)).toBe('"*.xyz" · 0 files')
  })

  test("empty/missing output reports 0 files", () => {
    expect(summarizeGlob({ pattern: "*" }, "", true)).toBe('"*" · 0 files')
  })

  test("missing pattern shows placeholder", () => {
    expect(summarizeGlob({}, "/x", true)).toBe("(no pattern) · 1 file")
  })
})
