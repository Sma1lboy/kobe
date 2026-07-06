import { describe, expect, it } from "bun:test"
import { DialogProvider, useDialog } from "../../src/tui/ui/dialog"
import { renderComponent, settle } from "./harness"

function Driver(props: { onReady: (dialog: ReturnType<typeof useDialog>) => void }) {
  const dialog = useDialog()
  props.onReady(dialog)
  return <text>base content</text>
}

describe("DialogProvider", () => {
  it("renders no overlay when the stack is empty", async () => {
    const { frame } = await renderComponent(() => <DialogProvider>{<Driver onReady={() => {}} />}</DialogProvider>)
    const text = await frame()
    expect(text).toContain("base content")
  })

  it("push shows the dialog body on top of the base content", async () => {
    const { frame } = await renderComponent(() => (
      <DialogProvider>
        <Driver onReady={(dialog) => dialog.push(() => <text>dialog A</text>)} />
      </DialogProvider>
    ))
    const text = await frame()
    expect(text).toContain("base content")
    expect(text).toContain("dialog A")
  })

  it("replace swaps the top dialog instead of stacking", async () => {
    const { frame } = await renderComponent(() => (
      <DialogProvider>
        <Driver
          onReady={(dialog) => {
            dialog.push(() => <text>dialog A</text>)
            dialog.replace(() => <text>dialog B</text>)
          }}
        />
      </DialogProvider>
    ))
    const text = await frame()
    expect(text).not.toContain("dialog A")
    expect(text).toContain("dialog B")
  })

  it("esc pops the top dialog and fires its onClose", async () => {
    let closed = false
    const dialogRef: { current?: ReturnType<typeof useDialog> } = {}
    const { frame, mockInput } = await renderComponent(() => (
      <DialogProvider>
        <Driver
          onReady={(dialog) => {
            dialogRef.current = dialog
            dialog.push(
              () => <text>dialog A</text>,
              () => {
                closed = true
              },
            )
          }}
        />
      </DialogProvider>
    ))
    expect(await frame()).toContain("dialog A")
    mockInput.pressEscape()
    await settle()
    await frame()
    expect(closed).toBe(true)
    expect(dialogRef.current?.stack.length).toBe(0)
  })

  it("clear empties the whole stack at once", async () => {
    const dialogRef: { current?: ReturnType<typeof useDialog> } = {}
    const { frame } = await renderComponent(() => (
      <DialogProvider>
        <Driver
          onReady={(dialog) => {
            dialogRef.current = dialog
            dialog.push(() => <text>dialog A</text>)
            dialog.push(() => <text>dialog B</text>)
          }}
        />
      </DialogProvider>
    ))
    expect(await frame()).toContain("dialog B")
    dialogRef.current?.clear()
    const text = await frame()
    expect(text).not.toContain("dialog B")
    expect(dialogRef.current?.stack.length).toBe(0)
  })
})
