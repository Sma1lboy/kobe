import type { UIMessage } from "ai"
import { describe, expect, it } from "vitest"
import type { ChatItem } from "../../src/tui/chat/ChatRow"
import { chatItemsToAiSdkHistory } from "../../src/tui/chat/thread-history"

function assistant(parts: UIMessage["parts"]): ChatItem {
  return {
    kind: "ui",
    msg: {
      id: `msg-${parts.length}`,
      role: "assistant",
      parts,
    } as UIMessage,
  }
}

describe("chatItemsToAiSdkHistory", () => {
  it("converts prompt rows and assistant text parts into Kobe conversation history", () => {
    const history = chatItemsToAiSdkHistory([
      { kind: "prompt", text: "first request" },
      assistant([{ type: "text", text: "first answer" }]),
      { kind: "prompt", text: "second request" },
    ])

    expect(history).toEqual([
      { role: "user", text: "first request" },
      { role: "assistant", text: "first answer" },
      { role: "user", text: "second request" },
    ])
  })

  it("ignores errors and assistant messages without text content", () => {
    const history = chatItemsToAiSdkHistory([
      { kind: "prompt", text: "fix it" },
      { kind: "error", text: "runtime failed" },
      assistant([
        {
          type: "reasoning",
          text: "private chain",
          providerMetadata: undefined,
          state: "done",
        },
        {
          type: "dynamic-tool",
          toolName: "Bash",
          toolCallId: "call-1",
          state: "input-available",
          input: { command: "pwd" },
        },
      ] as UIMessage["parts"]),
    ])

    expect(history).toEqual([{ role: "user", text: "fix it" }])
  })

  it("joins multiple assistant text parts into one assistant history message", () => {
    const history = chatItemsToAiSdkHistory([
      assistant([
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ]),
    ])

    expect(history).toEqual([{ role: "assistant", text: "line one\n\nline two" }])
  })
})
