/** @jsxImportSource @opentui/react */
/**
 * HelpDialog — global keybindings reference (src/tui-react/component/help-dialog.tsx).
 * `HelpDialog.show` replaces the dialog stack top with it; the `?` chord
 * re-dismisses it (the mount-time `runTmuxCapturing` call degrades to a
 * harmless no-op without a real tmux server).
 */
import { describe, expect, it } from "bun:test"
import { useEffect } from "react"
import { HelpDialog } from "../../src/tui-react/component/help-dialog"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { act, renderComponent } from "./harness"

function Harness(props: { onReady?: (dialog: ReturnType<typeof useDialog>) => void }) {
  const dialog = useDialog()
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once show.
  useEffect(() => {
    props.onReady?.(dialog)
    HelpDialog.show(dialog)
  }, [])
  return <box />
}

describe("HelpDialog", () => {
  it("renders the title and at least one keybinding row", async () => {
    const { frame } = await renderComponent(<Harness />, {
      providers: { dialog: true },
      width: 100,
      height: 40,
    })
    const text = await frame()
    expect(text).toContain("kobe — keybindings")
    // Every keymap category renders with the "esc" close hint visible.
    expect(text).toContain("esc")
  })

  it("? dismisses the dialog (dialog stack empties)", async () => {
    const dialogRef: { current?: ReturnType<typeof useDialog> } = {}
    const { frame, mockInput } = await renderComponent(
      <Harness
        onReady={(d) => {
          dialogRef.current = d
        }}
      />,
      { providers: { dialog: true }, width: 100, height: 40 },
    )
    expect(await frame()).toContain("kobe — keybindings")
    // `?` clears the dialog stack (setState on the provider) — commit via act
    // before reading stack.length.
    act(() => mockInput.pressKey("?"))
    await frame()
    expect(dialogRef.current?.stack.length).toBe(0)
  })
})
