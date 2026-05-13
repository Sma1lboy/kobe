/**
 * Unit tests for the codex-local history parser.
 *
 * Why this layer matters: the live `codex exec --json` stream never
 * yields codex's `<environment_context>` envelope — that synthetic
 * "first user message" only appears in the on-disk rollout JSONL.
 * Without filtering, reloading a task's history shows it as a leading
 * user chat row containing the cwd / shell / timezone / sandbox
 * payload, which isn't what the user typed.
 */

import { deriveCodexUsageMetrics, parseJsonl } from "@/engine/codex-local/history"
import { describe, expect, it } from "vitest"

const SID = "test-session"

describe("codex history parser", () => {
  it("returns user + assistant message rows", () => {
    const raw = [
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-11T18:00:00Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-11T18:00:01Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      }),
    ].join("\n")
    const out = parseJsonl(raw, SID)
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(out[0]?.blocks).toEqual([{ type: "text", text: "hello" }])
  })

  it("hydrates persisted function_call rows as paired tool blocks", () => {
    const raw = [
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-11T18:00:00Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"pwd","workdir":"/tmp/repo"}',
          call_id: "call_1",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-11T18:00:01Z",
        payload: {
          type: "function_call_output",
          call_id: "call_1",
          output: '{"output":"/tmp/repo\\n","metadata":{"exit_code":0}}',
        },
      }),
    ].join("\n")

    const out = parseJsonl(raw, SID)

    expect(out).toEqual([
      {
        role: "assistant",
        timestamp: "2026-05-11T18:00:00Z",
        sessionId: SID,
        blocks: [
          {
            type: "tool_call",
            callId: "call_1",
            name: "exec_command",
            input: { cmd: "pwd", workdir: "/tmp/repo" },
          },
        ],
      },
      {
        role: "user",
        timestamp: "2026-05-11T18:00:01Z",
        sessionId: SID,
        blocks: [
          {
            type: "tool_result",
            callId: "call_1",
            output: { output: "/tmp/repo\n", metadata: { exit_code: 0 } },
            isError: false,
          },
        ],
      },
    ])
  })

  it("hydrates persisted custom_tool_call rows as paired tool blocks", () => {
    const raw = [
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-11T18:00:00Z",
        payload: {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call_apply",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch\n",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-11T18:00:01Z",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call_apply",
          output: '{"output":"Success\\n","metadata":{"exit_code":0}}',
        },
      }),
    ].join("\n")

    const out = parseJsonl(raw, SID)

    expect(out).toEqual([
      {
        role: "assistant",
        timestamp: "2026-05-11T18:00:00Z",
        sessionId: SID,
        blocks: [
          {
            type: "tool_call",
            callId: "call_apply",
            name: "apply_patch",
            input: "*** Begin Patch\n*** End Patch\n",
          },
        ],
      },
      {
        role: "user",
        timestamp: "2026-05-11T18:00:01Z",
        sessionId: SID,
        blocks: [
          {
            type: "tool_result",
            callId: "call_apply",
            output: { output: "Success\n", metadata: { exit_code: 0 } },
            isError: false,
          },
        ],
      },
    ])
  })

  it("hydrates non-empty reasoning rows and drops empty encrypted-only rows", () => {
    const raw = [
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-11T18:00:00Z",
        payload: { type: "reasoning", summary: [], content: null, encrypted_content: "gAAAA" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-11T18:00:01Z",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "checked history " }],
          content: [{ type: "reasoning_text", text: "mapped tools" }],
          encrypted_content: null,
        },
      }),
    ].join("\n")

    const out = parseJsonl(raw, SID)

    expect(out).toEqual([
      {
        role: "assistant",
        timestamp: "2026-05-11T18:00:01Z",
        sessionId: SID,
        blocks: [{ type: "thinking", text: "mapped tools" }],
      },
    ])
  })

  it("hydrates single-record visible tool items instead of dropping them", () => {
    const raw = JSON.stringify({
      type: "response_item",
      timestamp: "2026-05-11T18:00:00Z",
      payload: {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "Codex ResponseItem" },
      },
    })

    const out = parseJsonl(raw, SID)

    expect(out).toEqual([
      {
        role: "assistant",
        timestamp: "2026-05-11T18:00:00Z",
        sessionId: SID,
        blocks: [
          {
            type: "tool_call",
            callId: "web_search_call:2026-05-11T18:00:00Z",
            name: "web_search_call",
            input: { action: { type: "search", query: "Codex ResponseItem" } },
          },
          {
            type: "tool_result",
            callId: "web_search_call:2026-05-11T18:00:00Z",
            output: {
              status: "completed",
              action: { type: "search", query: "Codex ResponseItem" },
            },
            isError: false,
          },
        ],
      },
    ])
  })

  it("drops the leading <environment_context> envelope user row", () => {
    // Real shape captured from `~/.codex/sessions/.../rollout-*.jsonl`:
    // codex injects this as the first user message of every session.
    const envelope =
      "<environment_context>\n  <cwd>/tmp/work</cwd>\n  <shell>zsh</shell>\n  <current_date>2026-05-11</current_date>\n</environment_context>"
    const raw = [
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-11T18:00:00Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: envelope }] },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-11T18:00:01Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "actual question" }] },
      }),
    ].join("\n")
    const out = parseJsonl(raw, SID)
    expect(out).toHaveLength(1)
    expect(out[0]?.blocks).toEqual([{ type: "text", text: "actual question" }])
  })

  it("drops AGENTS.md instruction envelopes persisted as synthetic user rows", () => {
    const instructions = [
      "# AGENTS.md instructions for /tmp/repo",
      "",
      "<INSTRUCTIONS>",
      "# kobe",
      "",
      "Read the docs before coding.",
      "</INSTRUCTIONS>",
    ].join("\n")
    const raw = [
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-11T18:00:00Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: instructions }] },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-11T18:00:01Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "actual question" }] },
      }),
    ].join("\n")

    const out = parseJsonl(raw, SID)

    expect(out).toHaveLength(1)
    expect(out[0]?.blocks).toEqual([{ type: "text", text: "actual question" }])
  })

  it("does NOT drop a user message that merely starts with <environment_context>", () => {
    // Conservative — only the exact envelope (no other text) is
    // filtered. A user pasting an envelope-shaped snippet survives.
    const text = "<environment_context>example</environment_context>\n\nplease parse this"
    const raw = JSON.stringify({
      type: "response_item",
      timestamp: "2026-05-11T18:00:00Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    })
    const out = parseJsonl(raw, SID)
    expect(out).toHaveLength(1)
  })

  it("preserves an assistant message even if it contains the envelope substring", () => {
    // Filter is gated on role === "user" — assistant responses never
    // accidentally get culled.
    const text = "<environment_context>foo</environment_context>"
    const raw = JSON.stringify({
      type: "response_item",
      timestamp: "2026-05-11T18:00:00Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    })
    const out = parseJsonl(raw, SID)
    expect(out).toHaveLength(1)
    expect(out[0]?.role).toBe("assistant")
  })

  it("derives Codex usage without treating cumulative totals as per-turn speed", () => {
    const raw = [
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-11T18:00:00Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
      }),
      JSON.stringify({
        type: "turn.completed",
        timestamp: "2026-05-11T18:00:10Z",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 30,
          output_tokens: 11,
          reasoning_output_tokens: 500,
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-11T18:01:00Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "second" }] },
      }),
      JSON.stringify({
        type: "turn.completed",
        timestamp: "2026-05-11T18:01:10Z",
        usage: {
          input_tokens: 140,
          cached_input_tokens: 50,
          output_tokens: 13,
          reasoning_output_tokens: 700,
        },
      }),
    ].join("\n")

    expect(deriveCodexUsageMetrics(raw)).toEqual({
      input_tokens: 90,
      cache_read_input_tokens: 50,
      output_tokens: 13,
    })
  })
})
