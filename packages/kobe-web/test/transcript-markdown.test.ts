import { describe, expect, it } from "vitest"
import type { ContentBlock, HistoryMessage } from "../src/lib/history.ts"
import {
  messageMarkdown,
  transcriptToMarkdown,
} from "../src/lib/transcript-markdown.ts"

type ToolResult = Extract<ContentBlock, { type: "tool_result" }>

const msg = (
  role: HistoryMessage["role"],
  blocks: ContentBlock[],
): HistoryMessage =>
  ({ role, blocks, timestamp: "", sessionId: "s" }) as HistoryMessage

const resultsOf = (messages: HistoryMessage[]): Map<string, ToolResult> => {
  const map = new Map<string, ToolResult>()
  for (const m of messages)
    for (const b of m.blocks)
      if (b.type === "tool_result") map.set(b.callId, b)
  return map
}

const meta = { title: "fix login", vendor: "claude", total: 2 }

describe("transcriptToMarkdown", () => {
  it("renders a heading, vendor + count notes, and role sections", () => {
    const messages = [
      msg("user", [{ type: "text", text: "fix the login bug" }]),
      msg("assistant", [{ type: "text", text: "On it." }]),
    ]
    const md = transcriptToMarkdown(messages, resultsOf(messages), false, meta)
    expect(md).toContain("# fix login — transcript")
    expect(md).toContain("`claude` · 2 messages")
    expect(md).toContain("### You\n\nfix the login bug")
    expect(md).toContain("### Assistant\n\nOn it.")
    // sections are separated by a horizontal rule
    expect(md).toContain("\n\n---\n\n")
  })

  it("attaches a tool call's result output to its ↳ line as a fenced block", () => {
    const messages = [
      msg("assistant", [
        { type: "text", text: "running it" },
        { type: "tool_call", callId: "c1", name: "Bash", input: { command: "npm test" } },
      ]),
      // Codex-style: the result lands on a separate (user-role) message.
      msg("user", [
        { type: "tool_result", callId: "c1", output: "2 passed", isError: false },
      ]),
    ]
    const md = transcriptToMarkdown(messages, resultsOf(messages), false, meta)
    expect(md).toContain("**↳ Bash** `npm test`")
    expect(md).toContain("```")
    expect(md).toContain("2 passed")
  })

  it("drops tool calls and adds a 'tools hidden' note when hideTools is on", () => {
    const messages = [
      msg("assistant", [
        { type: "text", text: "running it" },
        { type: "tool_call", callId: "c1", name: "Bash", input: { command: "npm test" } },
      ]),
    ]
    const md = transcriptToMarkdown(messages, resultsOf(messages), true, {
      ...meta,
      total: 1,
    })
    expect(md).toContain("tools hidden")
    expect(md).not.toContain("↳ Bash")
    expect(md).toContain("running it")
  })

  it("skips a message that renders nothing (tool_result-only / empty text)", () => {
    const messages = [
      msg("user", [{ type: "text", text: "hi" }]),
      msg("user", [
        { type: "tool_result", callId: "c1", output: "out", isError: false },
      ]),
      msg("assistant", [{ type: "text", text: "   \n" }]),
    ]
    const md = transcriptToMarkdown(messages, resultsOf(messages), false, {
      ...meta,
      total: 3,
    })
    // only the "hi" message renders a section → exactly one role header
    expect(md.match(/^### /gm)?.length).toBe(1)
    expect(md).toContain("### You\n\nhi")
  })

  it("reports a partial count when the shown slice is smaller than total", () => {
    const messages = [msg("user", [{ type: "text", text: "just this one" }])]
    const md = transcriptToMarkdown(messages, resultsOf(messages), false, {
      ...meta,
      total: 9,
    })
    expect(md).toContain("1 of 9 messages")
  })

  it("renders thinking as a blockquote and escapes a ``` fence in tool output", () => {
    const messages = [
      msg("assistant", [
        { type: "thinking", text: "let me\nthink" },
        { type: "tool_call", callId: "c1", name: "Read", input: { file_path: "a.md" } },
      ]),
      msg("user", [
        {
          type: "tool_result",
          callId: "c1",
          output: "```js\ncode\n```",
          isError: false,
        },
      ]),
    ]
    const md = transcriptToMarkdown(messages, resultsOf(messages), false, {
      ...meta,
      total: 2,
    })
    expect(md).toContain("> 💭 let me")
    expect(md).toContain("> think")
    // inner ``` forces a ```` fence so the block doesn't break out
    expect(md).toContain("````")
  })
})

describe("messageMarkdown (single-message copy)", () => {
  it("renders one role section for a prose message", () => {
    const m = msg("assistant", [{ type: "text", text: "Here's the fix." }])
    expect(messageMarkdown(m, new Map(), false)).toBe(
      "### Assistant\n\nHere's the fix.",
    )
  })

  it("includes a tool call + its resolved output", () => {
    const m = msg("assistant", [
      { type: "tool_call", callId: "c1", name: "Read", input: { path: "a" } },
    ])
    const results = resultsOf([
      msg("user", [
        { type: "tool_result", callId: "c1", output: "file body", isError: false },
      ]),
    ])
    const md = messageMarkdown(m, results, false)
    expect(md).toContain("### Assistant")
    expect(md).toContain("Read")
    expect(md).toContain("file body")
  })

  it("drops a tool-only message when tools are hidden, else null on empty", () => {
    const toolOnly = msg("assistant", [
      { type: "tool_call", callId: "c1", name: "Read", input: {} },
    ])
    expect(messageMarkdown(toolOnly, new Map(), true)).toBeNull()
    const blank = msg("assistant", [{ type: "text", text: "   " }])
    expect(messageMarkdown(blank, new Map(), false)).toBeNull()
  })
})
