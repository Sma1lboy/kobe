/**
 * HelpDialog — global keybindings reference (src/tui/component/help-dialog.tsx).
 * `HelpDialog.show` pushes it onto the real dialog stack; the `?` chord
 * re-dismisses it (the mount-time `runTmuxCapturing` call degrades to a
 * harmless no-op without a real tmux server — see src/tmux/client.ts).
 */
import { describe, expect, it } from "bun:test"
import { HelpDialog } from "../../src/tui/component/help-dialog"
import { useDialog } from "../../src/tui/ui/dialog"
import { renderComponent } from "./harness"

function Harness() {
  const dialog = useDialog()
  HelpDialog.show(dialog)
  return <box />
}

describe("HelpDialog", () => {
  it("renders the title and at least one keybinding row", async () => {
    const { frame } = await renderComponent(() => <Harness />, {
      providers: { dialog: true },
      width: 100,
      height: 40,
    })
    const text = await frame()
    expect(text).toContain("kobe — keybindings")
    // Every keymap category renders a row with the "esc" close hint visible.
    expect(text).toContain("esc")
  })

  it("? dismisses the dialog (dialog stack empties)", async () => {
    const dialog = { current: undefined as ReturnType<typeof useDialog> | undefined }
    function Capture() {
      dialog.current = useDialog()
      HelpDialog.show(dialog.current)
      return <box />
    }
    const { frame, mockInput } = await renderComponent(() => <Capture />, {
      providers: { dialog: true },
      width: 100,
      height: 40,
    })
    expect(await frame()).toContain("kobe — keybindings")
    mockInput.pressKey("?")
    await frame()
    expect(dialog.current?.stack.length).toBe(0)
  })
})
