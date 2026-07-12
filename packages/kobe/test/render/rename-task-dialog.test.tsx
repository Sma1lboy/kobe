/** @jsxImportSource @opentui/react */
/**
 * RenameTaskDialog — single-field rename prompt
 * (src/tui-react/component/rename-task-dialog.tsx). Drives the public
 * `RenameTaskDialog.show` entry point (same call the sidebar's `r` chord makes)
 * rather than the inner view directly.
 */
import { describe, expect, it } from "bun:test"
import { useEffect } from "react"
import { RenameTaskDialog } from "../../src/tui-react/component/rename-task-dialog"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { renderComponent, settle } from "./harness"

function Harness(props: { onResult: (v: string | undefined) => void }) {
  const dialog = useDialog()
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once show.
  useEffect(() => {
    void RenameTaskDialog.show(dialog, "old title").then(props.onResult)
  }, [])
  return <box />
}

describe("RenameTaskDialog", () => {
  it("pre-fills the input with the current title", async () => {
    const { frame } = await renderComponent(<Harness onResult={() => {}} />, {
      providers: { dialog: true },
    })
    const text = await frame()
    expect(text).toContain("Rename task")
    expect(text).toContain("old title")
  })

  it("typing replaces the field and enter resolves the new title", async () => {
    let result: string | undefined
    const { frame, mockInput } = await renderComponent(
      <Harness
        onResult={(v) => {
          result = v
        }}
      />,
      { providers: { dialog: true } },
    )
    await frame()
    // Clear the pre-filled text (one backspace per char of "old title"),
    // then type the replacement.
    for (let i = 0; i < "old title".length; i++) mockInput.pressBackspace()
    await frame()
    await mockInput.typeText("new title")
    await frame()
    mockInput.pressEnter()
    await frame()
    expect(result).toBe("new title")
  })

  it("chained shows start from fresh input state (add-engine flow leak)", async () => {
    // Pins the Settings → Engines "+ Add engine" bug: the flow chains three
    // RenameTaskDialog.show prompts (id → command → name), and without a
    // per-entry React key on the dialog stack the SAME view type reconciled
    // in place, so prompt N's typed text leaked into prompt N+1 (an engine
    // added as "aider" ended up with command "aideraider --model sonnet").
    let second: string | undefined
    function ChainHarness() {
      const dialog = useDialog()
      // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once show.
      useEffect(() => {
        void (async () => {
          await RenameTaskDialog.show(dialog, "", { fieldLabel: "id" })
          second = await RenameTaskDialog.show(dialog, "", { fieldLabel: "command" })
        })()
      }, [])
      return <box />
    }
    const { frame, mockInput } = await renderComponent(<ChainHarness />, {
      providers: { dialog: true },
    })
    await frame()
    await mockInput.typeText("aider")
    await frame()
    mockInput.pressEnter()
    await settle()
    const secondFrame = await frame()
    expect(secondFrame).toContain("command")
    expect(secondFrame).not.toContain("aider") // fresh input, no leaked text
    await mockInput.typeText("run")
    await settle()
    await frame()
    mockInput.pressEnter()
    await settle()
    expect(second).toBe("run") // pre-fix this was "aiderrun"
  })

  it("esc cancels without resolving a value", async () => {
    let result: string | undefined = "unset"
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
