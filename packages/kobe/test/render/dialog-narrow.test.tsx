/** @jsxImportSource @opentui/react */
/**
 * Narrow dialog clamp (issue #14, M5/3A): body padding halves below the
 * breakpoint (one shared hook, live on resize), the card width clamps to
 * terminal−2, and the new-chat footer hint wraps to a second line instead
 * of clipping. Content itself is unchanged.
 */

import { expect, test } from "bun:test"
import { NewChatDialogView } from "../../src/tui-react/component/new-chat-dialog"
import { useDialogPaddingX } from "../../src/tui-react/ui/dialog"
import { act, renderComponent } from "./harness"

function PaddingProbe() {
  return <text>{`padX:${useDialogPaddingX()}`}</text>
}

test("dialog body padding halves below the breakpoint and follows resize", async () => {
  const { frame, resize } = await renderComponent(<PaddingProbe />, { width: 80, height: 24 })
  expect(await frame()).toContain("padX:2")
  await act(async () => {
    resize(46, 70)
  })
  expect(await frame()).toContain("padX:1")
})

test("new-chat dialog at 46 cols keeps its full footer hint across wrapped lines", async () => {
  const { frame } = await renderComponent(
    <NewChatDialogView
      availableVendors={["claude", "codex"]}
      defaultVendor="claude"
      allowShell={true}
      onSubmit={() => {}}
      onCancel={() => {}}
    />,
    { width: 46, height: 24, providers: { dialog: true } },
  )
  const out = await frame()
  // The hint's head AND tail both render — wrapped, not clipped.
  expect(out).toContain("←/→ or h/l choose")
  expect(out.replace(/\n/g, " ")).toMatch(/esc\s+cancel|esc cancel/)
})
