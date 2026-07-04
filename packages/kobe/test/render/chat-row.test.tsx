import { describe, expect, it } from "bun:test"
import type { SdkResultMessage } from "../../src/engine/claude-code-local/headless"
import { ChatRow } from "../../src/tui/chat/ChatRow"
import { renderComponent } from "./harness"

describe("ChatRow", () => {
  it("omits cost from the result footer", async () => {
    const msg: SdkResultMessage = {
      type: "result",
      subtype: "success",
      duration_ms: 9600,
      total_cost_usd: 4.1239,
      usage: { output_tokens: 112 },
    }
    const { frame } = await renderComponent(
      () => <ChatRow item={{ kind: "sdk", msg }} results={new Map()} expanded={false} />,
      { width: 80, height: 4 },
    )

    const text = await frame()
    expect(text).toContain("9.6s")
    expect(text).toContain("112 tok")
    expect(text).not.toContain("$4.1239")
  })
})
