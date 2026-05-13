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
  QUEUE_SOFT_CAP,
  SCROLLBACK_CAP,
  applyEvent,
  cleanChatText,
  clearQueue,
  createInitialState,
  dequeueFirst,
  drainPendingBashContext,
  enqueueBashCommand,
  enqueuePrompt,
  formatBashContextPrefix,
  patchBashRow,
  pushBashRow,
  pushPendingBashContext,
  pushSystemError,
  pushUser,
  queueIsFull,
  removeFromQueue,
  reset,
  setMessagesFromHistory,
  updateQueueItem,
} from "../../src/tui/panes/chat/store.ts"
import { summarizeGlob, summarizeGrep, summarizeRead } from "../../src/tui/panes/chat/tool-banners.ts"
import type { EngineEvent, Message } from "../../src/types/engine.ts"

const FIXED_TS = "2026-05-09T00:00:00.000Z"

describe("createInitialState", () => {
  test("returns empty messages, not streaming, no error, empty queue", () => {
    const s = createInitialState()
    expect(s.messages).toEqual([])
    expect(s.isStreaming).toBe(false)
    expect(s.error).toBeNull()
    expect(s.queue).toEqual([])
  })

  test("`reset` is an alias", () => {
    expect(reset()).toEqual(createInitialState())
  })
})

describe("queue reducers", () => {
  test("enqueuePrompt appends a unique-id entry without touching messages or streaming", () => {
    const s0 = pushUser(createInitialState(), "first user msg", FIXED_TS)
    expect(s0.queue).toEqual([])
    expect(s0.isStreaming).toBe(true)

    const s1 = enqueuePrompt(s0, "queued one", FIXED_TS)
    expect(s1.queue).toHaveLength(1)
    const head = s1.queue[0]
    if (head?.kind !== "prompt") throw new Error("type narrowing")
    expect(head.text).toBe("queued one")
    expect(head.ts).toBe(FIXED_TS)
    expect(head.id).toMatch(/^q-/)
    // pushUser side effects intact
    expect(s1.messages).toEqual(s0.messages)
    expect(s1.isStreaming).toBe(true)
  })

  test("enqueuePrompt assigns distinct ids to back-to-back enqueues at the same ts", () => {
    let s = createInitialState()
    s = enqueuePrompt(s, "a", FIXED_TS)
    s = enqueuePrompt(s, "b", FIXED_TS)
    s = enqueuePrompt(s, "c", FIXED_TS)
    const ids = s.queue.map((q) => q.id)
    expect(new Set(ids).size).toBe(3)
  })

  test("enqueuePrompt is a no-op (and queueIsFull true) at the soft cap", () => {
    let s = createInitialState()
    for (let i = 0; i < QUEUE_SOFT_CAP; i++) s = enqueuePrompt(s, `q${i}`, FIXED_TS)
    expect(s.queue).toHaveLength(QUEUE_SOFT_CAP)
    expect(queueIsFull(s)).toBe(true)
    const refused = enqueuePrompt(s, "overflow", FIXED_TS)
    expect(refused).toBe(s)
    expect(refused.queue).toHaveLength(QUEUE_SOFT_CAP)
  })

  test("dequeueFirst returns [unchanged, null] when queue is empty", () => {
    const s0 = createInitialState()
    const [s1, head] = dequeueFirst(s0)
    expect(head).toBeNull()
    expect(s1).toBe(s0)
  })

  test("dequeueFirst pops the head and preserves order of the tail", () => {
    let s = createInitialState()
    s = enqueuePrompt(s, "a", FIXED_TS)
    s = enqueuePrompt(s, "b", FIXED_TS)
    s = enqueuePrompt(s, "c", FIXED_TS)

    const promptText = (q: { kind: "prompt"; text: string } | { kind: "bash"; command: string }) =>
      q.kind === "prompt" ? q.text : `!${q.command}`

    const [s1, h1] = dequeueFirst(s)
    if (h1?.kind !== "prompt") throw new Error("type narrowing")
    expect(h1.text).toBe("a")
    expect(s1.queue.map(promptText)).toEqual(["b", "c"])

    const [s2, h2] = dequeueFirst(s1)
    if (h2?.kind !== "prompt") throw new Error("type narrowing")
    expect(h2.text).toBe("b")
    expect(s2.queue.map(promptText)).toEqual(["c"])
  })

  test("removeFromQueue drops the matching entry, leaves siblings intact", () => {
    let s = createInitialState()
    s = enqueuePrompt(s, "a", FIXED_TS)
    s = enqueuePrompt(s, "b", FIXED_TS)
    s = enqueuePrompt(s, "c", FIXED_TS)
    const targetId = s.queue[1]?.id
    expect(targetId).toBeDefined()
    const next = removeFromQueue(s, targetId as string)
    expect(next.queue.map((q) => (q.kind === "prompt" ? q.text : `!${q.command}`))).toEqual(["a", "c"])
  })

  test("removeFromQueue with an unknown id is a no-op (identity preserved)", () => {
    let s = createInitialState()
    s = enqueuePrompt(s, "a", FIXED_TS)
    const next = removeFromQueue(s, "q-does-not-exist")
    expect(next).toBe(s)
  })

  test("updateQueueItem rewrites text in place, keeping id, ts, and position", () => {
    let s = createInitialState()
    s = enqueuePrompt(s, "a", FIXED_TS)
    s = enqueuePrompt(s, "b", FIXED_TS)
    s = enqueuePrompt(s, "c", FIXED_TS)
    const target = s.queue[1]
    expect(target).toBeDefined()
    const next = updateQueueItem(s, target?.id as string, "B-edited")
    expect(next.queue.map((q) => (q.kind === "prompt" ? q.text : `!${q.command}`))).toEqual(["a", "B-edited", "c"])
    expect(next.queue[1]?.id).toBe(target?.id)
    expect(next.queue[1]?.ts).toBe(target?.ts)
  })

  test("updateQueueItem with an unknown id is a no-op (identity preserved)", () => {
    let s = createInitialState()
    s = enqueuePrompt(s, "a", FIXED_TS)
    const next = updateQueueItem(s, "q-does-not-exist", "whatever")
    expect(next).toBe(s)
  })

  test("updateQueueItem with the same text is a no-op (identity preserved)", () => {
    let s = createInitialState()
    s = enqueuePrompt(s, "a", FIXED_TS)
    const id = s.queue[0]?.id as string
    const next = updateQueueItem(s, id, "a")
    expect(next).toBe(s)
  })

  test("clearQueue empties the queue but leaves messages + streaming alone", () => {
    let s = pushUser(createInitialState(), "user", FIXED_TS)
    s = enqueuePrompt(s, "q1", FIXED_TS)
    s = enqueuePrompt(s, "q2", FIXED_TS)
    const cleared = clearQueue(s)
    expect(cleared.queue).toEqual([])
    expect(cleared.messages).toEqual(s.messages)
    expect(cleared.isStreaming).toBe(s.isStreaming)
  })

  test("clearQueue on an already-empty queue returns identity", () => {
    const s = createInitialState()
    expect(clearQueue(s)).toBe(s)
  })

  test("done event flips isStreaming false but does NOT touch the queue", () => {
    let s = pushUser(createInitialState(), "user", FIXED_TS)
    s = enqueuePrompt(s, "queued", FIXED_TS)
    expect(s.isStreaming).toBe(true)
    expect(s.queue).toHaveLength(1)

    const next = applyEvent(s, { type: "done" }, FIXED_TS)
    expect(next.isStreaming).toBe(false)
    expect(next.queue).toEqual(s.queue) // queue intact — drain happens at the chat-shell layer
  })
})

describe("bash mode queue reducers (KOB-83 mid-stream parity)", () => {
  // claude-code's handlePromptSubmit enqueues bash commands with
  // mode='bash' when a turn is mid-flight; kobe mirrors that with
  // a discriminated `QueuedPrompt` union so the drain microtask can
  // fork on `kind`. These tests pin that contract.

  test("enqueueBashCommand appends a bash entry with kind=bash + command", () => {
    const s = enqueueBashCommand(createInitialState(), "ls -la", FIXED_TS)
    expect(s.queue).toHaveLength(1)
    const head = s.queue[0]
    if (head?.kind !== "bash") throw new Error("type narrowing")
    expect(head.command).toBe("ls -la")
    expect(head.kind).toBe("bash")
    expect(head.ts).toBe(FIXED_TS)
    expect(head.id).toMatch(/^q-/)
  })

  test("enqueueBashCommand and enqueuePrompt share FIFO order", () => {
    let s = createInitialState()
    s = enqueuePrompt(s, "explain", FIXED_TS)
    s = enqueueBashCommand(s, "ls", FIXED_TS)
    s = enqueuePrompt(s, "and after", FIXED_TS)
    expect(s.queue.map((q) => q.kind)).toEqual(["prompt", "bash", "prompt"])
  })

  test("enqueueBashCommand honors QUEUE_SOFT_CAP", () => {
    let s = createInitialState()
    for (let i = 0; i < QUEUE_SOFT_CAP; i++) s = enqueueBashCommand(s, `cmd${i}`, FIXED_TS)
    expect(queueIsFull(s)).toBe(true)
    const refused = enqueueBashCommand(s, "overflow", FIXED_TS)
    expect(refused).toBe(s)
  })

  test("dequeueFirst on a mixed-kind queue pops bash and prompt items in order", () => {
    let s = createInitialState()
    s = enqueueBashCommand(s, "ls", FIXED_TS)
    s = enqueuePrompt(s, "explain", FIXED_TS)
    const [s1, h1] = dequeueFirst(s)
    if (h1?.kind !== "bash") throw new Error("type narrowing")
    expect(h1.command).toBe("ls")
    const [, h2] = dequeueFirst(s1)
    if (h2?.kind !== "prompt") throw new Error("type narrowing")
    expect(h2.text).toBe("explain")
  })
})

describe("bash mode reducers (KOB-83)", () => {
  test("pushBashRow appends a bash row with done=false and the given id", () => {
    const s0 = createInitialState()
    const s1 = pushBashRow(s0, { id: "bash-1", command: "ls" }, FIXED_TS)
    expect(s1.messages).toHaveLength(1)
    const row = s1.messages[0]
    expect(row?.kind).toBe("bash")
    if (row?.kind !== "bash") throw new Error("type narrowing")
    expect(row.id).toBe("bash-1")
    expect(row.command).toBe("ls")
    expect(row.stdout).toBe("")
    expect(row.stderr).toBe("")
    expect(row.done).toBe(false)
    expect(row.exitCode).toBeNull()
    expect(row.signal).toBeNull()
  })

  test("patchBashRow appends to stdout/stderr without replacing", () => {
    let s = pushBashRow(createInitialState(), { id: "b1", command: "echo hi" }, FIXED_TS)
    s = patchBashRow(s, "b1", { stdoutAppend: "hi" })
    s = patchBashRow(s, "b1", { stdoutAppend: "\nworld" })
    s = patchBashRow(s, "b1", { stderrAppend: "oh no" })
    const row = s.messages[0]
    if (row?.kind !== "bash") throw new Error("type narrowing")
    expect(row.stdout).toBe("hi\nworld")
    expect(row.stderr).toBe("oh no")
    expect(row.done).toBe(false)
  })

  test("patchBashRow flips done with exitCode/signal", () => {
    let s = pushBashRow(createInitialState(), { id: "b1", command: "ls" }, FIXED_TS)
    s = patchBashRow(s, "b1", { done: true, exitCode: 0, signal: null })
    const row = s.messages[0]
    if (row?.kind !== "bash") throw new Error("type narrowing")
    expect(row.done).toBe(true)
    expect(row.exitCode).toBe(0)
    expect(row.signal).toBeNull()
  })

  test("patchBashRow no-ops when id is unknown", () => {
    const s = pushBashRow(createInitialState(), { id: "b1", command: "ls" }, FIXED_TS)
    const next = patchBashRow(s, "b-other", { stdoutAppend: "ignored" })
    expect(next).toBe(s)
  })

  test("pushPendingBashContext + drainPendingBashContext is a FIFO round-trip", () => {
    let s: ChatState = createInitialState()
    s = pushPendingBashContext(s, { command: "ls", stdout: "a\n", stderr: "", exitCode: 0 })
    s = pushPendingBashContext(s, { command: "pwd", stdout: "/tmp\n", stderr: "", exitCode: 0 })
    expect(s.pendingBashContext).toHaveLength(2)
    const [next, drained] = drainPendingBashContext(s)
    expect(drained.map((d) => d.command)).toEqual(["ls", "pwd"])
    expect(next.pendingBashContext).toBeUndefined()
  })

  test("drainPendingBashContext on empty state returns the input identity-stable", () => {
    const s = createInitialState()
    const [next, drained] = drainPendingBashContext(s)
    expect(next).toBe(s)
    expect(drained).toEqual([])
  })

  test("formatBashContextPrefix wraps each interaction in <bash-*> XML tags", () => {
    const prefix = formatBashContextPrefix([{ command: "echo hi", stdout: "hi\n", stderr: "", exitCode: 0 }])
    expect(prefix).toContain("<bash-input>echo hi</bash-input>")
    expect(prefix).toContain("<bash-stdout>hi\n</bash-stdout>")
    expect(prefix).not.toContain("<bash-stderr>")
    // Trailing blank line separating context from the prompt body.
    expect(prefix.endsWith("\n")).toBe(true)
  })

  test("formatBashContextPrefix omits empty stderr/stdout sections", () => {
    const prefix = formatBashContextPrefix([{ command: "true", stdout: "", stderr: "", exitCode: 0 }])
    expect(prefix).toContain("<bash-input>true</bash-input>")
    expect(prefix).not.toContain("<bash-stdout>")
    expect(prefix).not.toContain("<bash-stderr>")
  })

  test("formatBashContextPrefix escapes XML metacharacters in command + output", () => {
    const prefix = formatBashContextPrefix([{ command: "echo '<x>&amp;'", stdout: "</tag>", stderr: "", exitCode: 0 }])
    expect(prefix).toContain("&lt;x&gt;")
    expect(prefix).toContain("&amp;amp;")
    expect(prefix).toContain("&lt;/tag&gt;")
  })

  test("formatBashContextPrefix on an empty list is the empty string", () => {
    expect(formatBashContextPrefix([])).toBe("")
  })

  test("cleanChatText still strips <bash-input>/<bash-stdout>/<bash-stderr> on history replay", () => {
    // The prefix lands in the engine's JSONL via the next prompt; on
    // history hydration kobe's noise-tag filter must hide it from the
    // chat UI, matching upstream claude-code's behavior.
    const prefix = formatBashContextPrefix([{ command: "ls", stdout: "foo\nbar", stderr: "", exitCode: 0 }])
    const masquerading = `${prefix}what just happened?`
    expect(cleanChatText(masquerading)).toBe("what just happened?")
  })
})

describe("setMessagesFromHistory", () => {
  test("converts user/assistant Messages to chronological ChatRows", () => {
    const past: Message[] = [
      {
        role: "user",
        blocks: [{ type: "text", text: "hi" }],
        timestamp: "2026-05-09T00:00:00Z",
        sessionId: "s",
      },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "hello!" }],
        timestamp: "2026-05-09T00:00:01Z",
        sessionId: "s",
      },
      {
        role: "user",
        blocks: [{ type: "text", text: "how are you" }],
        timestamp: "2026-05-09T00:00:02Z",
        sessionId: "s",
      },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.messages).toHaveLength(3)
    expect(s.messages[0]).toEqual({ kind: "user", text: "hi", ts: "2026-05-09T00:00:00Z" })
    expect(s.messages[1]).toEqual({ kind: "assistant", text: "hello!", ts: "2026-05-09T00:00:01Z" })
    expect(s.messages[2]).toEqual({ kind: "user", text: "how are you", ts: "2026-05-09T00:00:02Z" })
  })

  test("concatenates consecutive text blocks into one row", () => {
    const past: Message[] = [
      {
        role: "assistant",
        blocks: [
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

  test("rehydrates lastUsage from the latest persisted usage record", () => {
    const past: Message[] = [
      {
        role: "user",
        blocks: [{ type: "text", text: "old prompt" }],
        timestamp: "2026-05-09T00:00:00Z",
        sessionId: "s",
      },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "old turn" }],
        timestamp: "2026-05-09T00:00:01Z",
        sessionId: "s",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 100 },
      },
      {
        role: "user",
        blocks: [{ type: "text", text: "new prompt" }],
        timestamp: "2026-05-09T00:00:03Z",
        sessionId: "s",
      },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "newer turn" }],
        timestamp: "2026-05-09T00:00:05Z",
        sessionId: "s",
        usage: {
          input_tokens: 6,
          output_tokens: 259,
          cache_creation_input_tokens: 2169,
          cache_read_input_tokens: 66900,
        },
      },
      { role: "user", blocks: [{ type: "text", text: "after" }], timestamp: "2026-05-09T00:00:06Z", sessionId: "s" },
    ]
    const s = setMessagesFromHistory(createInitialState(), past, {
      input_tokens: 6,
      output_tokens: 259,
      cache_creation_input_tokens: 2169,
      cache_read_input_tokens: 66900,
      total_speed_tokens_per_second: 89,
    })
    expect(s.lastUsage).toEqual({
      input_tokens: 6,
      output_tokens: 259,
      cache_creation_input_tokens: 2169,
      cache_read_input_tokens: 66900,
      total_speed_tokens_per_second: 89,
    })
  })

  test("leaves lastUsage undefined when no historical record carries usage", () => {
    const past: Message[] = [
      { role: "user", blocks: [{ type: "text", text: "hi" }], timestamp: "2026-05-09T00:00:00Z", sessionId: "s" },
      { role: "assistant", blocks: [{ type: "text", text: "ok" }], timestamp: "2026-05-09T00:00:01Z", sessionId: "s" },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.lastUsage).toBeUndefined()
  })

  test("extracts text blocks from array-shaped content", () => {
    const past: Message[] = [
      {
        role: "assistant",
        blocks: [
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

  test("renders tool_call blocks as collapsed tool rows", () => {
    const past: Message[] = [
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "running ls" },
          { type: "tool_call", callId: "tu_1", name: "Bash", input: { cmd: "ls" } },
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

  test("pairs tool_result with its matching tool_call by id and marks it done", () => {
    const past: Message[] = [
      {
        role: "assistant",
        blocks: [{ type: "tool_call", callId: "tu_1", name: "Bash", input: { cmd: "ls" } }],
        timestamp: "2026-05-09T00:00:00Z",
        sessionId: "s",
      },
      {
        role: "user",
        blocks: [{ type: "tool_result", callId: "tu_1", output: "file1\nfile2", isError: false }],
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

  test("pairs tool_call ↔ tool_result correctly when same name fires twice in parallel", () => {
    // Two Bash calls; results arrive out-of-order. Name-only matching
    // would mismatch — id matching gets it right.
    const past: Message[] = [
      {
        role: "assistant",
        blocks: [
          { type: "tool_call", callId: "tu_a", name: "Bash", input: { cmd: "first" } },
          { type: "tool_call", callId: "tu_b", name: "Bash", input: { cmd: "second" } },
        ],
        timestamp: FIXED_TS,
        sessionId: "s",
      },
      {
        role: "user",
        blocks: [
          { type: "tool_result", callId: "tu_b", output: "second-result", isError: false },
          { type: "tool_result", callId: "tu_a", output: "first-result", isError: false },
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
        blocks: [{ type: "tool_call", callId: "tu_1", name: "Read", input: { path: "x" } }],
        timestamp: FIXED_TS,
        sessionId: "s",
      },
      {
        role: "user",
        blocks: [{ type: "tool_result", callId: "tu_1", output: "ok", isError: false }],
        timestamp: FIXED_TS,
        sessionId: "s",
      },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.messages.filter((r) => r.kind === "user")).toHaveLength(0)
    expect(s.messages.filter((r) => r.kind === "assistant")).toHaveLength(0)
    expect(s.messages.filter((r) => r.kind === "tool")).toHaveLength(1)
  })

  test("orphan tool_result (no matching tool_call) renders as a standalone tool row", () => {
    const past: Message[] = [
      {
        role: "user",
        blocks: [{ type: "tool_result", callId: "missing", output: "stranded", isError: false }],
        timestamp: FIXED_TS,
        sessionId: "s",
      },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]).toMatchObject({ kind: "tool", done: true, output: "stranded" })
  })

  test("hydrates thinking blocks as reasoning rows", () => {
    const past: Message[] = [
      {
        role: "assistant",
        blocks: [
          { type: "thinking", text: "internal reasoning" },
          { type: "text", text: "answer" },
        ],
        timestamp: FIXED_TS,
        sessionId: "s",
      },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.messages).toEqual([
      { kind: "reasoning", text: "internal reasoning", ts: FIXED_TS },
      { kind: "assistant", text: "answer", ts: FIXED_TS },
    ])
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

describe("applyEvent — reasoning.delta", () => {
  test("drops empty reasoning chunks", () => {
    const s = applyEvent(createInitialState(), { type: "reasoning.delta", text: "" }, FIXED_TS)
    expect(s.messages).toEqual([])
  })

  test("appends and streams reasoning text into one row", () => {
    let s = applyEvent(createInitialState(), { type: "reasoning.delta", text: "looked " }, FIXED_TS)
    s = applyEvent(s, { type: "reasoning.delta", text: "at streams" }, FIXED_TS)
    expect(s.messages).toEqual([{ kind: "reasoning", text: "looked at streams", ts: FIXED_TS }])
  })
})

describe("applyEvent — usage / done / error", () => {
  test("usage records lastUsage without touching messages", () => {
    const start = pushUser(createInitialState(), "hi", FIXED_TS)
    const s = applyEvent(
      start,
      {
        type: "usage",
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 100,
        total_speed_tokens_per_second: 300,
      },
      "2026-05-09T00:00:05.000Z",
    )
    expect(s.messages).toEqual(start.messages)
    expect(s.isStreaming).toBe(start.isStreaming)
    expect(s.lastUsage).toEqual({
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 100,
      total_speed_tokens_per_second: 300,
    })
  })

  test("pushUser clears lastUsage for a new turn", () => {
    let s = pushUser(createInitialState(), "hi", FIXED_TS)
    s = applyEvent(s, { type: "usage", input_tokens: 1, output_tokens: 2 }, FIXED_TS)
    s = pushUser(s, "again", FIXED_TS)
    expect(s.lastUsage).toBeUndefined()
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

  test("strips KOB-83 bash-context XML prefix so the user row shows only the human text", () => {
    // The KOB-83 bash mode prepends <bash-input>/<bash-stdout> XML to
    // the next prompt sent to runTask; orchestrator dispatches the
    // FULL prefixed text as a user.inject event. Without the live-path
    // strip the chat shows the raw XML alongside the actual prompt
    // (see the screenshot in the KOB-83 PR review pass).
    const prefixed =
      "<bash-input>ls</bash-input>\n<bash-stdout>foo\nbar</bash-stdout>\n\nexplain what the listing shows"
    const s = applyEvent(createInitialState(), { type: "user.inject", text: prefixed }, FIXED_TS)
    expect(s.messages).toHaveLength(1)
    const row = s.messages[0]
    if (row?.kind !== "user") throw new Error("type narrowing")
    expect(row.text).toBe("explain what the listing shows")
    expect(s.isStreaming).toBe(true)
  })

  test("suppresses the user row entirely when only XML noise remains after stripping", () => {
    // A bash interaction can fire mid-stream and produce a user.inject
    // whose payload is just the XML wrapper (no trailing user text).
    // Adding an empty user row would render as a bare `>` chip — the
    // history-replay path already drops these via cleanChatText;
    // mirror it here.
    const xmlOnly = "<bash-input>pwd</bash-input>\n<bash-stdout>/tmp</bash-stdout>\n"
    const s = applyEvent(createInitialState(), { type: "user.inject", text: xmlOnly }, FIXED_TS)
    expect(s.messages).toEqual([])
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
      {
        role: "user",
        blocks: [{ type: "text", text: "old user" }],
        timestamp: "2026-05-09T00:00:00Z",
        sessionId: "s",
      },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "old assistant" }],
        timestamp: "2026-05-09T00:00:01Z",
        sessionId: "s",
      },
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
        blocks: [{ type: "text", text: "<local-command-caveat>Caveat: don't respond.</local-command-caveat>" }],
        timestamp: FIXED_TS,
        sessionId: "s",
      },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "real reply" }],
        timestamp: FIXED_TS,
        sessionId: "s",
      },
    ]
    const s = setMessagesFromHistory(createInitialState(), past)
    expect(s.messages.map((r) => r.kind)).toEqual(["assistant"])
    expect(s.messages[0]).toMatchObject({ text: "real reply" })
  })

  test("history hydration keeps user text after stripping a caveat block", () => {
    const past: Message[] = [
      {
        role: "user",
        blocks: [{ type: "text", text: "<local-command-caveat>noise</local-command-caveat>my real prompt" }],
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
      blocks: [{ type: "text", text: `m${i}` }],
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
