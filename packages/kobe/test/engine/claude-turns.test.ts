/** Per-turn telemetry extraction from Claude's JSONL (issue #32). */

import { parseClaudeTurns } from "@/engine/claude-code-local/turns"
import { describe, expect, test } from "vitest"

const SID = "sess-1"

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record)
}

function user(ts: string, text = "do the thing"): string {
  return line({ type: "user", sessionId: SID, timestamp: ts, message: { role: "user", content: text } })
}

function assistant(
  ts: string,
  id: string,
  opts: { model?: string; usage?: Record<string, number>; content?: unknown } = {},
): string {
  return line({
    type: "assistant",
    sessionId: SID,
    timestamp: ts,
    message: {
      role: "assistant",
      id,
      model: opts.model ?? "claude-opus-5",
      content: opts.content ?? [{ type: "text", text: "ok" }],
      ...(opts.usage ? { usage: opts.usage } : {}),
    },
  })
}

describe("parseClaudeTurns", () => {
  test("one prompt + reply becomes one turn with model, span, and usage", () => {
    const raw = [
      user("2026-08-15T10:00:00.000Z"),
      assistant("2026-08-15T10:00:05.000Z", "msg_a", {
        usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000 },
      }),
    ].join("\n")

    expect(parseClaudeTurns(raw)).toEqual([
      {
        id: "msg_a",
        sessionId: SID,
        model: "claude-opus-5",
        startedAt: Date.parse("2026-08-15T10:00:00.000Z"),
        endedAt: Date.parse("2026-08-15T10:00:05.000Z"),
        usage: {
          input_tokens: 10,
          output_tokens: 200,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 0,
        },
      },
    ])
  })

  test("usage is counted once per message id, not once per record", () => {
    // Claude writes one record per content block, repeating the same usage.
    const usage = { input_tokens: 4, output_tokens: 500 }
    const raw = [
      user("2026-08-15T10:00:00.000Z"),
      assistant("2026-08-15T10:00:01.000Z", "msg_a", { usage, content: [{ type: "thinking", thinking: "hm" }] }),
      assistant("2026-08-15T10:00:02.000Z", "msg_a", { usage, content: [{ type: "tool_use", name: "Bash" }] }),
      assistant("2026-08-15T10:00:03.000Z", "msg_a", { usage }),
    ].join("\n")

    const [turn] = parseClaudeTurns(raw)
    expect(turn.usage?.output_tokens).toBe(500)
    expect(turn.endedAt).toBe(Date.parse("2026-08-15T10:00:03.000Z"))
  })

  test("tool_result user records continue the turn instead of opening one", () => {
    const raw = [
      user("2026-08-15T10:00:00.000Z"),
      assistant("2026-08-15T10:00:01.000Z", "msg_a", { usage: { input_tokens: 1, output_tokens: 10 } }),
      line({
        type: "user",
        sessionId: SID,
        timestamp: "2026-08-15T10:00:02.000Z",
        message: { role: "user", content: [{ type: "tool_result", content: "done" }] },
      }),
      assistant("2026-08-15T10:00:03.000Z", "msg_b", { usage: { input_tokens: 1, output_tokens: 20 } }),
    ].join("\n")

    const turns = parseClaudeTurns(raw)
    expect(turns).toHaveLength(1)
    expect(turns[0].id).toBe("msg_b") // last assistant message closes the turn
    expect(turns[0].usage?.output_tokens).toBe(30)
  })

  test("two prompts yield two turns, each with its own id", () => {
    const raw = [
      user("2026-08-15T10:00:00.000Z"),
      assistant("2026-08-15T10:00:01.000Z", "msg_a"),
      user("2026-08-15T10:01:00.000Z", "and again"),
      assistant("2026-08-15T10:01:04.000Z", "msg_b"),
    ].join("\n")

    expect(parseClaudeTurns(raw).map((t) => t.id)).toEqual(["msg_a", "msg_b"])
  })

  test("synthetic records, malformed lines, and reply-less turns are dropped", () => {
    const raw = [
      line({
        type: "user",
        isMeta: true,
        sessionId: SID,
        timestamp: "2026-08-15T09:59:00.000Z",
        message: { role: "user", content: "caveat" },
      }),
      "{not json",
      "",
      user("2026-08-15T10:00:00.000Z"), // interrupted: never answered
      user("2026-08-15T10:02:00.000Z", "second"),
      assistant("2026-08-15T10:02:01.000Z", "msg_b"),
    ].join("\n")

    expect(parseClaudeTurns(raw).map((t) => t.id)).toEqual(["msg_b"])
  })

  test("empty transcript yields no turns", () => {
    expect(parseClaudeTurns("")).toEqual([])
  })
})
