/**
 * QuickTaskComposer — prompt-first quick-task dialog (`<prefix> f`), src/tui/component/quick-task-composer.tsx.
 * Covers the "type a prompt, hit enter" happy path and tab-cycling to the
 * engine field with ctrl+e stepping the vendor.
 */
import { describe, expect, it } from "bun:test"
import { QuickTaskComposer, type QuickTaskResult } from "../../src/tui/component/quick-task-composer"
import { useDialog } from "../../src/tui/ui/dialog"
import { renderComponent } from "./harness"

const OPTS = {
  repoLabel: "kobe",
  engines: ["claude", "codex"] as const,
  defaultVendor: "claude" as const,
  defaultBaseRef: "main",
  engineLabel: (v: string) => v,
}

function Harness(props: { onResult: (v: QuickTaskResult | undefined) => void }) {
  const dialog = useDialog()
  void QuickTaskComposer.show(dialog, OPTS).then(props.onResult)
  return <box />
}

describe("QuickTaskComposer", () => {
  it("shows the repo label and both engines, claude pre-selected", async () => {
    const { frame } = await renderComponent(() => <Harness onResult={() => {}} />, {
      providers: { dialog: true },
    })
    const text = await frame()
    expect(text).toContain("Quick task · kobe")
    expect(text).toContain("claude")
    expect(text).toContain("codex")
  })

  it("typing a prompt and hitting enter creates the task with the default engine/branch", async () => {
    let result: QuickTaskResult | undefined
    const { frame, mockInput } = await renderComponent(
      () => (
        <Harness
          onResult={(v) => {
            result = v
          }}
        />
      ),
      {
        providers: { dialog: true },
      },
    )
    await frame()
    await mockInput.typeText("fix the flaky test")
    mockInput.pressEnter()
    await frame()
    expect(result).toEqual({
      prompt: "fix the flaky test",
      vendor: "claude",
      baseRef: "main",
      attachments: [],
    })
  })

  it("tab then ctrl+e cycles the engine field to codex", async () => {
    let result: QuickTaskResult | undefined
    const { frame, mockInput } = await renderComponent(
      () => (
        <Harness
          onResult={(v) => {
            result = v
          }}
        />
      ),
      {
        providers: { dialog: true },
      },
    )
    await frame()
    await mockInput.typeText("switch engine")
    mockInput.pressTab() // prompt -> engine field
    mockInput.pressKey("e", { ctrl: true }) // step vendor within the engine field
    mockInput.pressEnter()
    await frame()
    expect(result?.vendor).toBe("codex")
  })
})
