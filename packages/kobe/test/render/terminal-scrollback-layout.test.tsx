/** @jsxImportSource @opentui/react */

import { expect, test } from "bun:test"
import { Terminal } from "../../src/tui-react/panes/terminal/Terminal"
import { createScriptedPtyRegistry } from "../../src/tui/panes/terminal/pty-scripted"
import { type RenderHandle, act, renderComponent } from "./harness"

async function mountTerminal(): Promise<{
  handle: RenderHandle
  harness: ReturnType<typeof createScriptedPtyRegistry>
}> {
  const harness = createScriptedPtyRegistry()
  let handle: RenderHandle | undefined
  await act(async () => {
    handle = await renderComponent(
      <Terminal cwd="/wt" taskId="scrollback-layout" focused registry={harness.registry} />,
      { width: 60, height: 16, providers: { dialog: true } },
    )
  })
  if (!handle) throw new Error("terminal mount failed")
  await act(async () => {
    await handle?.frame()
  })
  return { handle, harness }
}

test("entering scrollback does not resize the child PTY", async () => {
  const { handle, harness } = await mountTerminal()
  try {
    const pty = harness.last()
    await act(async () => {
      pty.feed(Array.from({ length: 60 }, (_, index) => `line-${index + 1}`).join("\r\n"))
      await handle.frame()
    })
    const before = pty.geometry

    await act(async () => {
      await handle.mockMouse.scroll(20, 8, "up")
      await handle.frame()
    })

    expect(await handle.frame()).toMatch(/scrolled|已回滚/)
    expect(pty.geometry).toEqual(before)
  } finally {
    handle.destroy()
  }
})
