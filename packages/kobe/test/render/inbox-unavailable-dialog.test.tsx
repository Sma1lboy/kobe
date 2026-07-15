/** @jsxImportSource @opentui/react */

import { describe, expect, it } from "bun:test"
import { useEffect } from "react"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { InboxUnavailableDialog } from "../../src/tui-react/workspace/InboxUnavailableDialog"
import { act, renderComponent, settle } from "./harness"

function Harness() {
  const dialog = useDialog()
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once show.
  useEffect(() => {
    InboxUnavailableDialog.show(dialog, "Chat tab unavailable", "This Inbox item is retained.")
  }, [])
  return <box />
}

describe("InboxUnavailableDialog", () => {
  it("shows a modal notice and closes on enter", async () => {
    const { frame, mockInput } = await renderComponent(<Harness />, { providers: { dialog: true } })
    expect(await frame()).toContain("Chat tab unavailable")
    expect(await frame()).toContain("This Inbox item is retained.")

    act(() => mockInput.pressEnter())
    await settle()
    expect(await frame()).not.toContain("Chat tab unavailable")
  })
})
