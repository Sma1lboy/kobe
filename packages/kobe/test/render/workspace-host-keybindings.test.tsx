/** @jsxImportSource @opentui/react */

import { describe, expect, it } from "bun:test"
import { useFocus } from "../../src/tui-react/context/focus"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { useWorkspaceKeybindings } from "../../src/tui-react/workspace/host-keybindings"
import { renderComponent, settle } from "./harness"

function Probe(props: { opened: string[]; focusLog?: string[] }) {
  const focus = useFocus()
  const dialog = useDialog()
  props.focusLog?.splice(0, props.focusLog.length, focus.focused)
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

  it("clamps focus movement at both ends instead of wrapping", async () => {
    const focusLog: string[] = []
    const { mockInput } = await renderComponent(<Probe opened={[]} focusLog={focusLog} />, {
      providers: { focus: true, dialog: true },
    })

    async function prefixStroke(key: string) {
      mockInput.pressKey("a", { ctrl: true })
      await settle()
      await mockInput.typeText(key)
      await settle()
    }

    // Boot focus is sidebar (left end) — prefix+h must not wrap to files.
    await prefixStroke("h")
    expect(focusLog[0]).toBe("sidebar")

    // Walk right to the files end, then prefix+l must not wrap to sidebar.
    await prefixStroke("l")
    expect(focusLog[0]).toBe("workspace")
    await prefixStroke("l")
    expect(focusLog[0]).toBe("files")
    await prefixStroke("l")
    expect(focusLog[0]).toBe("files")
  })
})
