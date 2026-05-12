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

import { parseJsonl } from "@/engine/codex-local/history"
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
})
