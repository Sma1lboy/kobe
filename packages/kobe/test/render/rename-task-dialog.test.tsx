/**
 * RenameTaskDialog — single-field rename prompt (src/tui/component/rename-task-dialog/{index,dialog}.tsx).
 * Drives it through the public `RenameTaskDialog.show` entry point (same
 * call the sidebar's `r` chord makes) rather than the inner view directly.
 */
import { describe, expect, it } from "bun:test"
import { RenameTaskDialog } from "../../src/tui/component/rename-task-dialog"
import { useDialog } from "../../src/tui/ui/dialog"
import { renderComponent, settle } from "./harness"

function Harness(props: { onResult: (v: string | undefined) => void }) {
  const dialog = useDialog()
  void RenameTaskDialog.show(dialog, "old title").then(props.onResult)
  return <box />
}

describe("RenameTaskDialog", () => {
  it("pre-fills the input with the current title", async () => {
    const { frame } = await renderComponent(() => <Harness onResult={() => {}} />, {
      providers: { dialog: true },
    })
    const text = await frame()
    expect(text).toContain("Rename task")
    expect(text).toContain("old title")
  })

  it("typing replaces the field and enter resolves the new title", async () => {
    let result: string | undefined
    const { frame, mockInput } = await renderComponent(
      () => (
        <Harness
          onResult={(v) => {
            result = v
          }}
        />
      ),
      {
        providers: { dialog: true },
      },
    )
    await frame()
    // Clear the pre-filled text (one backspace per character of "old title"),
    // then type the replacement.
    for (let i = 0; i < "old title".length; i++) mockInput.pressBackspace()
    await mockInput.typeText("new title")
    mockInput.pressEnter()
    await frame()
    expect(result).toBe("new title")
  })

  it("esc cancels without resolving a value", async () => {
    let result: string | undefined = "unset"
    const { frame, mockInput } = await renderComponent(
      () => (
        <Harness
          onResult={(v) => {
            result = v
          }}
        />
      ),
      {
        providers: { dialog: true },
      },
    )
    await frame()
    mockInput.pressEscape()
    await settle()
    await frame()
    expect(result).toBeUndefined()
  })
})
