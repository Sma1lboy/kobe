import { describe, expect, it } from "vitest"
import type { ContentBlock, HistoryMessage } from "../src/lib/history.ts"
import {
  blockVisible,
  messageMatchesQuery,
  messageSearchText,
} from "../src/lib/transcript-search.ts"

const msg = (
  role: HistoryMessage["role"],
  blocks: ContentBlock[],
): HistoryMessage =>
  ({ role, blocks, timestamp: "", sessionId: "s" }) as HistoryMessage

describe("messageSearchText", () => {
  it("concatenates prose, thinking, tool-call name+input, and result output", () => {
    const m = msg("assistant", [
      { type: "text", text: "let me read the file" },
      { type: "thinking", text: "hmm" },
      { type: "tool_call", callId: "c1", name: "Read", input: { file_path: "src/app.ts" } },
      { type: "tool_result", callId: "c1", output: "line one\nline two", isError: false },
    ])
    const text = messageSearchText(m)
    expect(text).toContain("let me read the file")
    expect(text).toContain("hmm")
    expect(text).toContain("Read")
    expect(text).toContain("src/app.ts")
    expect(text).toContain("line one")
  })
})

describe("messageMatchesQuery", () => {
  const m = msg("assistant", [
    { type: "text", text: "Fixing the login bug" },
    { type: "tool_call", callId: "c1", name: "Bash", input: { command: "npm test" } },
    { type: "tool_result", callId: "c1", output: "2 failed", isError: true },
  ])

  it("matches everything for a blank query", () => {
    expect(messageMatchesQuery(m, "")).toBe(true)
    expect(messageMatchesQuery(m, "   ")).toBe(true)
  })

  it("matches prose case-insensitively", () => {
    expect(messageMatchesQuery(m, "LOGIN")).toBe(true)
  })

  it("matches a tool command", () => {
    expect(messageMatchesQuery(m, "npm test")).toBe(true)
  })

  it("matches text inside a tool result", () => {
    expect(messageMatchesQuery(m, "2 failed")).toBe(true)
  })

  it("matches a tool name", () => {
    expect(messageMatchesQuery(m, "bash")).toBe(true)
  })

  it("returns false when nothing in the message matches", () => {
    expect(messageMatchesQuery(m, "deploy-prod")).toBe(false)
  })

  it("trims the query", () => {
    expect(messageMatchesQuery(m, "  login  ")).toBe(true)
  })
})

describe("blockVisible (hide tool calls)", () => {
  const text: ContentBlock = { type: "text", text: "hi" }
  const thinking: ContentBlock = { type: "thinking", text: "hmm" }
  const toolCall: ContentBlock = {
    type: "tool_call",
    callId: "c1",
    name: "Bash",
    input: {},
  }

  it("shows everything when hideTools is off", () => {
    expect(blockVisible(text, false)).toBe(true)
    expect(blockVisible(thinking, false)).toBe(true)
    expect(blockVisible(toolCall, false)).toBe(true)
  })

  it("hides only tool_call blocks when hideTools is on", () => {
    expect(blockVisible(toolCall, true)).toBe(false)
    expect(blockVisible(text, true)).toBe(true)
    expect(blockVisible(thinking, true)).toBe(true)
  })
})
