/** @jsxImportSource @opentui/react */

import { describe, expect, it } from "bun:test"
import { type CapturedFrame, TextAttributes } from "@opentui/core"
import { NewTaskDialogView } from "../../src/tui-react/component/new-task-dialog/dialog"
import { act, renderComponent } from "./harness"

function findSpan(frame: CapturedFrame, needle: string) {
  return frame.lines.flatMap((line) => line.spans).find((span) => span.text.includes(needle))
}

describe("NewTaskDialogView", () => {
  it("moves section focus directly to a clicked input", async () => {
    const { destroy, frame, mockInput, mockMouse, spans } = await renderComponent(
      <NewTaskDialogView
        defaultRepo=""
        savedRepos={[]}
        availableVendors={["claude", "codex"]}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
      { width: 90, height: 24, providers: { dialog: true } },
    )

    try {
      const initial = await frame()
      const lines = initial.split("\n")
      const labelY = lines.findIndex((line) => line.includes("from branch"))
      const inputY = labelY + 1
      const inputX = lines[inputY]?.indexOf("main") ?? -1
      expect(labelY).toBeGreaterThanOrEqual(0)
      expect(inputX).toBeGreaterThanOrEqual(0)

      await act(async () => mockMouse.click(inputX, inputY))
      const branchLabel = findSpan(await spans(), "from branch")
      expect((branchLabel?.attributes ?? 0) & TextAttributes.UNDERLINE).toBe(TextAttributes.UNDERLINE)

      await act(async () => mockInput.pressTab())
      expect(await frame()).toContain("▸ [ Create ]")
    } finally {
      destroy()
    }
  })
})
