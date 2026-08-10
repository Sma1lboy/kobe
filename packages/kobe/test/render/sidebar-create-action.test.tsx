/** @jsxImportSource @opentui/react */
/**
 * Task creation is a labelled, full-row sidebar action rather than a tiny
 * header glyph. Assert against a real frame and a real mouse click: both the
 * hierarchy and the hit target are rendered behavior, not component props.
 */

import { expect, test } from "bun:test"
import { SidebarCreateAction } from "../../src/tui-react/panes/sidebar/chrome"
import { renderComponent } from "./harness"

function lineOf(frame: string, needle: string): number {
  return frame.split("\n").findIndex((line) => line.includes(needle))
}

test("renders a labelled task action with the live default keycap", async () => {
  const { frame } = await renderComponent(<SidebarCreateAction onAddTask={() => {}} />, {
    width: 24,
    height: 5,
  })
  const text = await frame()

  expect(text).toContain("+ New task")
  expect(text.split("\n")[lineOf(text, "New task")]).toMatch(/New task\s+n/)
  expect(text).not.toContain("[+]")
})

test("clicking anywhere on the action row creates a task", async () => {
  let calls = 0
  const { frame, mockMouse } = await renderComponent(<SidebarCreateAction onAddTask={() => calls++} />, {
    width: 24,
    height: 5,
  })
  const text = await frame()

  await mockMouse.click(12, lineOf(text, "New task"))
  expect(calls).toBe(1)
})
