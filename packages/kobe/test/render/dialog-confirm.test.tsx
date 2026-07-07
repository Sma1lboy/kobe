/** @jsxImportSource @opentui/react */
/**
 * DialogConfirm — yes/no prompt (src/tui-react/ui/dialog-confirm.tsx). Drives
 * the real DialogProvider stack (DialogConfirm.show pushes onto it) and asserts
 * the actual keyboard flow: left/right swaps the focused button, enter commits,
 * esc cancels via the dialog stack's own escape binding.
 */
import { describe, expect, it } from "bun:test"
import { useEffect } from "react"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { DialogConfirm } from "../../src/tui-react/ui/dialog-confirm"
import { act, renderComponent, settle } from "./harness"

function Harness(props: { onResult: (v: boolean | undefined) => void }) {
  const dialog = useDialog()
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once show.
  useEffect(() => {
    void DialogConfirm.show(dialog, "Delete task?", "This cannot be undone.").then(props.onResult)
  }, [])
  return <box />
}

describe("DialogConfirm", () => {
  it("shows the title and message, confirm focused by default", async () => {
    const { frame } = await renderComponent(<Harness onResult={() => {}} />, {
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
      <Harness
        onResult={(v) => {
          result = v
        }}
      />,
      { providers: { dialog: true } },
    )
    await frame()
    mockInput.pressEnter()
    await frame()
    expect(result).toBe(true)
  })

  it("left then enter switches focus to Cancel and resolves false", async () => {
    let result: boolean | undefined
    const { frame, mockInput } = await renderComponent(
      <Harness
        onResult={(v) => {
          result = v
        }}
      />,
      { providers: { dialog: true } },
    )
    await frame()
    // The arrow flips React state (focused button); commit it via act before
    // enter reads the active button through the re-evaluated binding closure.
    act(() => mockInput.pressArrow("left"))
    await frame()
    act(() => mockInput.pressEnter())
    await frame()
    expect(result).toBe(false)
  })

  it("esc dismisses without resolving true or false", async () => {
    let result: boolean | undefined = "unset" as unknown as boolean | undefined
    const { frame, mockInput } = await renderComponent(
      <Harness
        onResult={(v) => {
          result = v
        }}
      />,
      { providers: { dialog: true } },
    )
    await frame()
    mockInput.pressEscape()
    await settle()
    await frame()
    expect(result).toBeUndefined()
  })
})
