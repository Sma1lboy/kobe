/** @jsxImportSource @opentui/react */

import { describe, expect, it } from "bun:test"
import { useFocus } from "../../src/tui-react/context/focus"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { useWorkspaceKeybindings } from "../../src/tui-react/workspace/host-keybindings"
import { renderComponent, settle } from "./harness"

function Probe(props: { opened: string[] }) {
  const focus = useFocus()
  const dialog = useDialog()
  useWorkspaceKeybindings({
    focus,
    dialog,
    settingsOpen: false,
    worktreesOpen: false,
    openWorktrees: () => {},
    updateOpen: false,
    openUpdate: () => {},
    kanbanOpen: false,
    openKanban: () => {},
    searchActive: false,
    selectedId: "task-1",
    openTaskWorktree: (id) => props.opened.push(id),
    openSettings: () => {},
    closeSettings: () => {},
    createTask: () => {},
    renameBranch: () => {},
    cycleVendor: () => {},
    toggleZen: () => {},
    jumpToNextAttention: () => {},
    openInbox: () => {},
    enterMoveMode: () => {},
    createPR: () => {},
  })
  return <text>ready</text>
}

describe("workspace host editor bindings", () => {
  it("opens the selected worktree from sidebar o and global prefix-o", async () => {
    const opened: string[] = []
    const { mockInput } = await renderComponent(<Probe opened={opened} />, {
      providers: { focus: true, dialog: true },
    })

    await mockInput.typeText("o")
    await settle()
    mockInput.pressKey("a", { ctrl: true })
    await settle()
    await mockInput.typeText("o")
    await settle()

    expect(opened).toEqual(["task-1", "task-1"])
  })
})
