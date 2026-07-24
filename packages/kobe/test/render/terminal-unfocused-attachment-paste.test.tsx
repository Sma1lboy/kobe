/** @jsxImportSource @opentui/react */
/**
 * Finder screenshot drag-drop routing while the workspace is unfocused.
 *
 * iTerm turns a file drop into a terminal paste event without preserving the
 * drop coordinates. Kobe therefore reuses IME-anchor ownership to designate
 * exactly one mounted Terminal: the visible ChatTab's active leaf. That target
 * may consume an existing image/PDF path while Sidebar or Files owns keyboard
 * focus; ordinary text, non-target terminals, and modal-covered terminals
 * must remain untouched.
 */
import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import { useEffect } from "react"
import { Terminal } from "../../src/tui-react/panes/terminal/Terminal"
import { useTerminalBindings } from "../../src/tui-react/panes/terminal/keys"
import { DialogProvider, useDialog } from "../../src/tui-react/ui/dialog"
import { createScriptedPtyRegistry } from "../../src/tui/panes/terminal/pty-scripted"
import { act, renderComponent, settle } from "./harness"

const IMAGE_PATH = resolve(import.meta.dir, "../../../../public/assets/logos/cursor-block.png")

function PasteProbe(props: {
  focused?: boolean
  target?: boolean
  pastes: string[]
}) {
  useTerminalBindings({
    focused: props.focused === true,
    unfocusedAttachmentTarget: props.target,
    write: () => {},
    paste: (text) => props.pastes.push(text),
    scroll: () => {},
    reset: () => {},
  })
  return <box />
}

function DialogDriver(props: { onMount: (dialog: ReturnType<typeof useDialog>) => void }) {
  const dialog = useDialog()
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only test handoff.
  useEffect(() => props.onMount(dialog), [])
  return null
}

describe("terminal pane — unfocused attachment paste", () => {
  it("routes through the visible Terminal's IME-anchor ownership without focus", async () => {
    const harness = createScriptedPtyRegistry()
    const { renderer, frame } = await renderComponent(
      <Terminal cwd="/wt" taskId="chat" focused={false} imeAnchorActive registry={harness.registry} />,
      { providers: { dialog: true } },
    )
    await frame()

    act(() => renderer.keyInput.processPaste(new TextEncoder().encode(IMAGE_PATH)))
    await settle()

    expect(harness.last().pastes).toEqual([IMAGE_PATH])
  })

  it("leaves ordinary text and non-target terminals untouched", async () => {
    const pastes: string[] = []
    const { renderer } = await renderComponent(<PasteProbe pastes={pastes} />)

    act(() => {
      renderer.keyInput.processPaste(new TextEncoder().encode(IMAGE_PATH))
      renderer.keyInput.processPaste(new TextEncoder().encode("explain this failure"))
    })
    await settle()

    expect(pastes).toHaveLength(0)
  })

  it("delivers to only the designated terminal when multiple leaves are mounted", async () => {
    const targetPastes: string[] = []
    const siblingPastes: string[] = []
    const { renderer } = await renderComponent(
      <>
        <PasteProbe pastes={siblingPastes} />
        <PasteProbe target pastes={targetPastes} />
      </>,
    )

    act(() => renderer.keyInput.processPaste(new TextEncoder().encode(IMAGE_PATH)))
    await settle()

    expect(targetPastes).toEqual([IMAGE_PATH])
    expect(siblingPastes).toHaveLength(0)
  })

  it("keeps the focused terminal's normal paste behavior", async () => {
    const pastes: string[] = []
    const { renderer } = await renderComponent(<PasteProbe focused pastes={pastes} />)

    act(() => renderer.keyInput.processPaste(new TextEncoder().encode("ordinary prompt text")))
    await settle()

    expect(pastes).toEqual(["ordinary prompt text"])
  })

  it("does not route behind an open modal", async () => {
    const pastes: string[] = []
    const dialogRef: { current?: ReturnType<typeof useDialog> } = {}
    const { renderer, frame } = await renderComponent(
      <DialogProvider>
        <PasteProbe target pastes={pastes} />
        <DialogDriver
          onMount={(dialog) => {
            dialogRef.current = dialog
          }}
        />
      </DialogProvider>,
    )

    act(() => dialogRef.current?.replace(() => <text>rename dialog</text>))
    expect(await frame()).toContain("rename dialog")
    act(() => renderer.keyInput.processPaste(new TextEncoder().encode(IMAGE_PATH)))
    await settle()

    expect(pastes).toHaveLength(0)
  })
})
