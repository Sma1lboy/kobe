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
import { useEffect, useState } from "react"
import { Terminal } from "../../src/tui-react/panes/terminal/Terminal"
import { useTerminalBindings } from "../../src/tui-react/panes/terminal/keys"
import { DialogProvider, useDialog } from "../../src/tui-react/ui/dialog"
import { type ScriptedPtyRegistry, createScriptedPtyRegistry } from "../../src/tui/panes/terminal/pty-scripted"
import { act, renderComponent, settle } from "./harness"

const IMAGE_PATH = resolve(import.meta.dir, "../../../../public/assets/logos/cursor-block.png")

function PasteProbe(props: {
  focused?: boolean
  target?: boolean
  pastes: string[]
}) {
  useTerminalBindings({
    focused: props.focused === true,
    unfocusedAttachmentTarget: props.target === true,
    write: () => {},
    paste: (text) => props.pastes.push(text),
    scroll: () => {},
    reset: () => {},
  })
  return <box />
}

function ActiveLeafTerminals(props: {
  harness: ScriptedPtyRegistry
  api: { setActive?: (leaf: "left" | "right") => void }
}) {
  const [active, setActive] = useState<"left" | "right">("left")
  props.api.setActive = setActive
  return (
    <box flexDirection="row" flexGrow={1}>
      <Terminal
        cwd="/wt"
        taskId="left"
        focused={false}
        imeAnchorActive={active === "left"}
        registry={props.harness.registry}
      />
      <Terminal
        cwd="/wt"
        taskId="right"
        focused={false}
        imeAnchorActive={active === "right"}
        registry={props.harness.registry}
      />
    </box>
  )
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

  it("leaves ordinary text untouched even on the designated target", async () => {
    const pastes: string[] = []
    const { renderer } = await renderComponent(<PasteProbe target pastes={pastes} />)

    act(() => renderer.keyInput.processPaste(new TextEncoder().encode("explain this failure")))
    await settle()

    expect(pastes).toHaveLength(0)
  })

  it("leaves attachment paths untouched on a non-target terminal", async () => {
    const pastes: string[] = []
    const { renderer } = await renderComponent(<PasteProbe pastes={pastes} />)

    act(() => renderer.keyInput.processPaste(new TextEncoder().encode(IMAGE_PATH)))
    await settle()

    expect(pastes).toHaveLength(0)
  })

  it("follows active-leaf ownership across multiple mounted Terminals", async () => {
    const harness = createScriptedPtyRegistry()
    const api: { setActive?: (leaf: "left" | "right") => void } = {}
    const { renderer, frame } = await renderComponent(<ActiveLeafTerminals harness={harness} api={api} />, {
      providers: { dialog: true },
    })
    await frame()
    expect(harness.ptys).toHaveLength(2)

    act(() => renderer.keyInput.processPaste(new TextEncoder().encode(IMAGE_PATH)))
    await settle()

    expect(harness.ptys[0]?.pastes).toEqual([IMAGE_PATH])
    expect(harness.ptys[1]?.pastes).toHaveLength(0)

    act(() => api.setActive?.("right"))
    await frame()
    act(() => renderer.keyInput.processPaste(new TextEncoder().encode(IMAGE_PATH)))
    await settle()

    expect(harness.ptys[0]?.pastes).toEqual([IMAGE_PATH])
    expect(harness.ptys[1]?.pastes).toEqual([IMAGE_PATH])
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
