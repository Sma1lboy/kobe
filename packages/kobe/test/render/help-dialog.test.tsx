/** @jsxImportSource @opentui/react */
/**
 * HelpDialog — global keybindings reference (src/tui-react/component/help-dialog.tsx).
 * `HelpDialog.show` replaces the dialog stack top with it; the `?` chord
 * re-dismisses it (the mount-time `runTmuxCapturing` call degrades to a
 * harmless no-op without a real tmux server).
 */
import { afterEach, describe, expect, it } from "bun:test"
import { useEffect } from "react"
import { HelpDialog } from "../../src/tui-react/component/help-dialog"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { configurePrefix, resetPrefixConfiguration } from "../../src/tui/lib/keymap-dispatch"
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

afterEach(() => resetPrefixConfiguration())

describe("HelpDialog", () => {
  it("renders the title and at least one keybinding row", async () => {
    const { frame } = await renderComponent(<Harness />, {
      providers: { dialog: true },
      width: 100,
      height: 40,
    })
    const text = await frame()
    expect(text).toContain("kobe — keybindings")
    expect(text).toContain("PureTUI prefix")
    expect(text).toContain("⌃ A · 1000ms")
    // Every keymap category renders with the "esc" close hint visible.
    expect(text).toContain("esc")
  })

  it("shows the configured prefix in the header and migrated action rows", async () => {
    configurePrefix({ key: "ctrl+b", timeoutMs: 750 })
    const { frame } = await renderComponent(<Harness />, {
      providers: { dialog: true },
      width: 100,
      height: 40,
    })

    const text = await frame()
    expect(text).toContain("PureTUI prefix: ⌃ B · 750ms")
    expect(text).toContain("prefix + o")
  })

  it("shows only relative prefix+h/l pane navigation", async () => {
    const { frame } = await renderComponent(<Harness />, {
      providers: { dialog: true },
      width: 100,
      height: 80,
    })

    const text = await frame()
    expect(text).toContain("prefix + h")
    expect(text).toContain("prefix + l")
    expect(text).toContain("prefix + i")
    expect(text).not.toContain("prefix + j")
    expect(text).not.toContain("prefix + k")
    expect(text).not.toContain("Jump to pane")
  })

  it("scrolls below the fold with keyboard-only navigation", async () => {
    const { frame, mockInput } = await renderComponent(<Harness />, {
      providers: { dialog: true },
      width: 100,
      height: 16,
    })
    const initial = await frame()
    expect(initial).toContain("kobe — keybindings")

    for (let line = 0; line < 4; line++) act(() => mockInput.pressArrow("down"))
    const scrolled = await frame()
    expect(scrolled).not.toBe(initial)

    // Home returns to the top; close still works afterwards.
    act(() => mockInput.pressKey("HOME"))
    expect(await frame()).toBe(initial)
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
