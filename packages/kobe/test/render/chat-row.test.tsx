import { describe, expect, it } from "bun:test"
import type { UIMessage } from "ai"
import { ChatRow } from "../../src/tui/chat/ChatRow"
import { renderComponent } from "./harness"

describe("ChatRow", () => {
  it("renders a UIMessage tool part with its resolved name and input summary", async () => {
    const msg: UIMessage = {
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "Bash",
          toolCallId: "t1",
          state: "input-available",
          input: { command: "ls -la" },
        },
      ],
    }
    const { frame } = await renderComponent(() => <ChatRow item={{ kind: "ui", msg }} expanded={false} />, {
      width: 80,
      height: 4,
    })

    const text = await frame()
    expect(text).toContain("Bash")
    expect(text).toContain("ls -la")
  })

  it("renders a persisted turn-failure error row", async () => {
    const { frame } = await renderComponent(
      () => <ChatRow item={{ kind: "error", text: "runtime exploded" }} expanded={false} />,
      { width: 80, height: 4 },
    )

    const text = await frame()
    expect(text).toContain("runtime exploded")
  })

  it("echoes a typed prompt with the ❯ marker", async () => {
    const { frame } = await renderComponent(
      () => <ChatRow item={{ kind: "prompt", text: "fix the bug" }} expanded={false} />,
      { width: 80, height: 4 },
    )

    const text = await frame()
    expect(text).toContain("❯")
    expect(text).toContain("fix the bug")
  })
})
