import { describe, expect, it } from "bun:test"
import { ChatTurnErrorBanner } from "../../src/tui/chat/ChatPane"
import { renderComponent } from "./harness"

describe("ChatTurnErrorBanner", () => {
  it("renders a turn error in the chat chrome layer", async () => {
    const { frame } = await renderComponent(() => <ChatTurnErrorBanner error="session limit resets 6:50am" />, {
      width: 80,
      height: 6,
    })

    const text = await frame()
    expect(text).toContain("error: session limit resets 6:50am")
  })

  it("renders nothing without an error", async () => {
    const { frame } = await renderComponent(() => <ChatTurnErrorBanner error={null} />, {
      width: 80,
      height: 6,
    })

    expect((await frame()).trim()).toBe("")
  })
})
