/** @jsxImportSource @opentui/react */
/**
 * DialogProvider / useDialog — the dialog stack itself
 * (src/tui-react/ui/dialog.tsx), independent of any concrete dialog.
 * push/replace/clear + the esc/ctrl+c dismiss-top binding every *Dialog
 * component relies on.
 */
import { describe, expect, it } from "bun:test"
import { useEffect } from "react"
import { useBindings } from "../../src/tui-react/lib/keymap"
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

  it("can anchor a dialog header at the viewport's upper quarter", async () => {
    const height = 24
    const { frame } = await renderComponent(
      <DialogProvider>
        <Driver
          onMount={(dialog) => {
            dialog.replace(() => <text>UPPER QUARTER</text>)
            dialog.setPlacement("upper-quarter")
          }}
        />
      </DialogProvider>,
      { width: 80, height },
    )
    const headerRow = (await frame()).split("\n").findIndex((line) => line.includes("UPPER QUARTER"))
    expect(headerRow).toBe(Math.floor(height / 4))
  })

  it("resets upper placement when a different dialog replaces it", async () => {
    const height = 24
    const dialogRef: { current?: ReturnType<typeof useDialog> } = {}
    const { frame } = await renderComponent(
      <DialogProvider>
        <Driver
          onMount={(dialog) => {
            dialogRef.current = dialog
            dialog.replace(() => <text>UPPER FIRST</text>)
            dialog.setPlacement("upper-quarter")
          }}
        />
      </DialogProvider>,
      { width: 80, height },
    )
    expect((await frame()).split("\n").findIndex((line) => line.includes("UPPER FIRST"))).toBe(Math.floor(height / 4))

    act(() => dialogRef.current?.replace(() => <text>CENTER NEXT</text>))
    const centeredRow = (await frame()).split("\n").findIndex((line) => line.includes("CENTER NEXT"))
    expect(centeredRow).toBeGreaterThan(Math.floor(height / 4))
  })

  // Regression (owner report 2026-07-09): the translucent full-screen
  // backdrop erased wide glyphs from the pane behind a dialog while leaving
  // adjacent ASCII visible. Keep mixed CJK/ASCII background text intact so
  // opening a modal only dims it; it must not punch character-shaped holes.
  it("keeps wide glyphs in background text while a dialog is open", async () => {
    const background = "设置 split horizon 和 vertical 深度限制"
    const dialogRef: { current?: ReturnType<typeof useDialog> } = {}
    const { frame, spans } = await renderComponent(
      <DialogProvider>
        <text fg="#FFFFFF">{background}</text>
        <Driver
          onMount={(dialog) => {
            dialogRef.current = dialog
          }}
        />
      </DialogProvider>,
      { width: 100, height: 24 },
    )

    const before = await spans()
    const beforeText = before.lines.flatMap((line) => line.spans).find((span) => span.text.includes("split horizon"))
    expect(beforeText).toBeDefined()

    act(() => dialogRef.current?.push(() => <text>dialog A</text>))
    const text = await frame()
    expect(text).toContain(background)
    expect(text).toContain("dialog A")

    const after = await spans()
    const dimmedText = after.lines.flatMap((line) => line.spans).find((span) => span.text.includes("split horizon"))
    expect(dimmedText).toBeDefined()
    expect(dimmedText?.fg.equals(beforeText?.fg)).toBe(false)
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

  // Structural modal guarantee (owner mandate 2026-07-08): while ANY
  // dialog is up, bindings registered by the UI behind it must be
  // unreachable — no per-pane `dialog.stack.length === 0` gate required.
  it("blocks background bindings while a dialog is open, restores them after", async () => {
    let background = 0
    const dialogRef: { current?: ReturnType<typeof useDialog> } = {}
    function Background() {
      useBindings(() => ({
        bindings: [
          {
            key: "j",
            cmd: () => {
              background++
            },
          },
        ],
      }))
      return <text>bg</text>
    }
    const { frame, mockInput } = await renderComponent(
      <DialogProvider>
        <Background />
        <Driver
          onMount={(dialog) => {
            dialogRef.current = dialog
          }}
        />
      </DialogProvider>,
    )
    await frame()
    act(() => mockInput.pressKey("j"))
    await settle()
    expect(background).toBe(1)

    act(() => dialogRef.current?.push(() => <text>dialog A</text>))
    expect(await frame()).toContain("dialog A")
    act(() => mockInput.pressKey("j")) // must hit the modal barrier, not the pane
    await settle()
    expect(background).toBe(1)

    act(() => mockInput.pressEscape())
    await settle()
    expect(await frame()).not.toContain("dialog A")
    act(() => mockInput.pressKey("j"))
    await settle()
    expect(background).toBe(2)
  })

  // The other half of the modal contract: bindings registered BY the dialog
  // body must stay reachable above the barrier. Precedence is declared
  // (ModalScopeContext membership + the barrier's modalOwner slot in
  // insertRegistration), not an effect-commit-order accident — this pins the
  // context stamping end-to-end through the real provider.
  it("dialog body bindings fire while the barrier blocks the background", async () => {
    let body = 0
    let background = 0
    function Background() {
      useBindings(() => ({ bindings: [{ key: "j", cmd: () => background++ }] }))
      return <text>bg</text>
    }
    function Body() {
      useBindings(() => ({ bindings: [{ key: "j", cmd: () => body++ }] }))
      return <text>dialog A</text>
    }
    const dialogRef: { current?: ReturnType<typeof useDialog> } = {}
    const { frame, mockInput } = await renderComponent(
      <DialogProvider>
        <Background />
        <Driver
          onMount={(dialog) => {
            dialogRef.current = dialog
          }}
        />
      </DialogProvider>,
    )
    await frame()
    act(() => dialogRef.current?.push(() => <Body />))
    expect(await frame()).toContain("dialog A")
    act(() => mockInput.pressKey("j"))
    await settle()
    expect(body).toBe(1)
    expect(background).toBe(0)
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
