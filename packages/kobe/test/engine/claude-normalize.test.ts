import { describe, expect, it } from "vitest"
import { normalizeClaudeContent } from "../../src/engine/claude-code-local/normalize.ts"

describe("normalizeClaudeContent", () => {
  it("wraps a non-empty string as one text block; empty → []", () => {
    expect(normalizeClaudeContent("hello")).toEqual([{ type: "text", text: "hello" }])
    expect(normalizeClaudeContent("")).toEqual([])
  })

  it("returns [] for non-array, non-string values", () => {
    expect(normalizeClaudeContent(null)).toEqual([])
    expect(normalizeClaudeContent(123)).toEqual([])
    expect(normalizeClaudeContent({ type: "text", text: "x" })).toEqual([])
  })

  it("normalizes text blocks and bare strings", () => {
    expect(normalizeClaudeContent([{ type: "text", text: "a" }, "b"])).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ])
  })

  it("maps tool_use to a tool_call block", () => {
    expect(normalizeClaudeContent([{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } }])).toEqual([
      { type: "tool_call", callId: "t1", name: "Bash", input: { cmd: "ls" } },
    ])
  })

  it("defaults missing tool_use id/name to empty strings", () => {
    expect(normalizeClaudeContent([{ type: "tool_use" }])).toEqual([
      { type: "tool_call", callId: "", name: "", input: undefined },
    ])
  })

  it("maps tool_result, reading tool_use_id and is_error", () => {
    expect(
      normalizeClaudeContent([{ type: "tool_result", tool_use_id: "t1", content: "out", is_error: true }]),
    ).toEqual([{ type: "tool_result", callId: "t1", output: "out", isError: true }])
  })

  it("maps thinking blocks", () => {
    expect(normalizeClaudeContent([{ type: "thinking", thinking: "hmm" }])).toEqual([{ type: "thinking", text: "hmm" }])
  })

  it("drops images, redacted_thinking, textless thinking, and unknown types", () => {
    expect(
      normalizeClaudeContent([
        { type: "image", source: {} },
        { type: "redacted_thinking", data: "x" },
        { type: "whatever" },
        { type: "thinking" },
      ]),
    ).toEqual([])
  })
})
