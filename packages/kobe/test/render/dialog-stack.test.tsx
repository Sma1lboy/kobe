/** @jsxImportSource @opentui/react */
/**
 * DialogProvider / useDialog — the dialog stack itself
 * (src/tui-react/ui/dialog.tsx), independent of any concrete dialog.
 * push/replace/clear + the esc/ctrl+c dismiss-top binding every *Dialog
 * component relies on.
 */
import { describe, expect, it } from "bun:test"
import { useEffect } from "react"
import { DialogProvider, useDialog } from "../../src/tui-react/ui/dialog"
import { act, renderComponent, settle } from "./harness"

function Driver(props: { onMount: (dialog: ReturnType<typeof useDialog>) => void }) {
  const dialog = useDialog()
  // Imperative stack mutations run once after mount — calling them during
  // render would setState the provider mid-render (React render loop).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once, matching the Solid setup semantics.
  useEffect(() => props.onMount(dialog), [])
  return <text>base content</text>
}

describe("DialogProvider", () => {
  it("renders no overlay when the stack is empty", async () => {
    const { frame } = await renderComponent(
      <DialogProvider>
        <Driver onMount={() => {}} />
      </DialogProvider>,
    )
    expect(await frame()).toContain("base content")
  })

  it("push shows the dialog body on top of the base content", async () => {
    const { frame } = await renderComponent(
      <DialogProvider>
        <Driver onMount={(dialog) => dialog.push(() => <text>dialog A</text>)} />
      </DialogProvider>,
    )
    const text = await frame()
    expect(text).toContain("base content")
    expect(text).toContain("dialog A")
  })

  it("replace swaps the top dialog instead of stacking", async () => {
    const { frame } = await renderComponent(
      <DialogProvider>
        <Driver
          onMount={(dialog) => {
            dialog.push(() => <text>dialog A</text>)
            dialog.replace(() => <text>dialog B</text>)
          }}
        />
      </DialogProvider>,
    )
    const text = await frame()
    expect(text).not.toContain("dialog A")
    expect(text).toContain("dialog B")
  })

  it("esc pops the top dialog and fires its onClose", async () => {
    let closed = false
    const dialogRef: { current?: ReturnType<typeof useDialog> } = {}
    const { frame, mockInput } = await renderComponent(
      <DialogProvider>
        <Driver
          onMount={(dialog) => {
            dialogRef.current = dialog
            dialog.push(
              () => <text>dialog A</text>,
              () => {
                closed = true
              },
            )
          }}
        />
      </DialogProvider>,
    )
    expect(await frame()).toContain("dialog A")
    mockInput.pressEscape()
    await settle()
    await frame()
    expect(closed).toBe(true)
    expect(dialogRef.current?.stack.length).toBe(0)
  })

  // Regression (owner report 2026-07-08): a stale text selection — the
  // terminal keeps the highlight after a copy until the next click — used
  // to DISABLE the esc/ctrl+c binding entirely, leaving esc dead while a
  // dialog was up. Contract now: first esc clears the selection (dialog
  // stays), second esc closes.
  it("esc clears a stale selection first, then closes on the next press", async () => {
    const dialogRef: { current?: ReturnType<typeof useDialog> } = {}
    const { frame, mockInput, renderer } = await renderComponent(
      <DialogProvider>
        <Driver
          onMount={(dialog) => {
            dialogRef.current = dialog
            dialog.push(() => <text>dialog A</text>)
          }}
        />
      </DialogProvider>,
    )
    expect(await frame()).toContain("dialog A")

    const patched = renderer as unknown as {
      getSelection: () => { getSelectedText: () => string } | null
      clearSelection: () => void
    }
    patched.getSelection = () => ({ getSelectedText: () => "stale copy highlight" })
    patched.clearSelection = () => {
      patched.getSelection = () => null
    }

    mockInput.pressEscape() // clears the selection; the dialog must survive
    await settle()
    expect(await frame()).toContain("dialog A")
    expect(patched.getSelection()).toBeNull()

    mockInput.pressEscape() // no selection left — now it closes
    await settle()
    expect(await frame()).not.toContain("dialog A")
    expect(dialogRef.current?.stack.length).toBe(0)
  })

  it("clear empties the whole stack at once", async () => {
    const dialogRef: { current?: ReturnType<typeof useDialog> } = {}
    const { frame } = await renderComponent(
      <DialogProvider>
        <Driver
          onMount={(dialog) => {
            dialogRef.current = dialog
            dialog.push(() => <text>dialog A</text>)
            dialog.push(() => <text>dialog B</text>)
          }}
        />
      </DialogProvider>,
    )
    expect(await frame()).toContain("dialog B")
    act(() => dialogRef.current?.clear())
    const text = await frame()
    expect(text).not.toContain("dialog B")
    expect(dialogRef.current?.stack.length).toBe(0)
  })
})
