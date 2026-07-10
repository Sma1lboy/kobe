/** @jsxImportSource @opentui/react */
/**
 * Modal barrier vs raw key forwarders (owner report 2026-07-09): the
 * terminal pane's catch-all keypress forwarder registers directly on
 * `renderer.keyInput`, bypassing `dispatchKeyEvent` and its modal cut-off.
 * Pane focus does NOT change when a dialog opens, so typing into e.g. the
 * rename-tab dialog used to be forwarded (and preventDefault'ed) into the
 * PTY behind it — the characters landed in the embedded CLI's composer
 * instead of the dialog field. Contract now: while ANY dialog is up,
 * every raw forwarder is mute (`modalActive()` in lib/keymap.ts) and
 * resumes as soon as the stack empties.
 */
import { describe, expect, it } from "bun:test"
import { useEffect } from "react"
import { useTerminalBindings } from "../../src/tui-react/panes/terminal/keys"
import { DialogProvider, useDialog } from "../../src/tui-react/ui/dialog"
import { act, renderComponent, settle } from "./harness"

function TerminalProbe(props: { writes: string[] }) {
  // `focused: true` throughout — the pane KEEPS focus while a dialog is
  // up (border stays lit); that unchanged focus is what made the leak.
  useTerminalBindings({
    focused: true,
    write: (d: string) => props.writes.push(d),
    paste: () => {},
    scroll: () => {},
    reset: () => {},
  })
  return <text>term</text>
}

function Driver(props: { onMount: (dialog: ReturnType<typeof useDialog>) => void }) {
  const dialog = useDialog()
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once, same as dialog-stack.test.tsx.
  useEffect(() => props.onMount(dialog), [])
  return null
}

describe("terminal pane — raw forwarder honors the dialog modal barrier", () => {
  it("stops forwarding to the PTY while a dialog is open, resumes after", async () => {
    const writes: string[] = []
    const dialogRef: { current?: ReturnType<typeof useDialog> } = {}
    const { frame, mockInput } = await renderComponent(
      <DialogProvider>
        <TerminalProbe writes={writes} />
        <Driver
          onMount={(dialog) => {
            dialogRef.current = dialog
          }}
        />
      </DialogProvider>,
    )
    await frame()

    await mockInput.typeText("a")
    await settle()
    expect(writes).toContain("a")

    act(() => dialogRef.current?.replace(() => <text>rename dialog</text>))
    expect(await frame()).toContain("rename dialog")
    await mockInput.typeText("b")
    await settle()
    expect(writes).not.toContain("b")

    act(() => mockInput.pressEscape())
    await settle()
    expect(await frame()).not.toContain("rename dialog")
    await mockInput.typeText("c")
    await settle()
    expect(writes).toContain("c")
  })
})
