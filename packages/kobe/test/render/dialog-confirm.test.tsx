import { describe, expect, it } from "bun:test"
import { useDialog } from "../../src/tui/ui/dialog"
import { DialogConfirm } from "../../src/tui/ui/dialog-confirm"
import { renderComponent, settle } from "./harness"

function Harness(props: { onResult: (v: boolean | undefined) => void }) {
  const dialog = useDialog()
  void DialogConfirm.show(dialog, "Delete task?", "This cannot be undone.").then(props.onResult)
  return <box />
}

describe("DialogConfirm", () => {
  it("shows the title and message, confirm focused by default", async () => {
    const { frame } = await renderComponent(() => <Harness onResult={() => {}} />, {
      providers: { dialog: true },
    })
    const text = await frame()
    expect(text).toContain("Delete task?")
    expect(text).toContain("This cannot be undone.")
    expect(text).toContain("Confirm")
    expect(text).toContain("Cancel")
  })

  it("enter on the default-focused Confirm button resolves true", async () => {
    let result: boolean | undefined
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
    mockInput.pressEnter()
    await frame()
    expect(result).toBe(true)
  })

  it("left then enter switches focus to Cancel and resolves false", async () => {
    let result: boolean | undefined
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
    mockInput.pressArrow("left")
    mockInput.pressEnter()
    await frame()
    expect(result).toBe(false)
  })

  it("esc dismisses without resolving true or false", async () => {
    let result: boolean | undefined = "unset" as unknown as boolean | undefined
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
