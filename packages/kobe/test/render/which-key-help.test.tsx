/** @jsxImportSource @opentui/react */
/** Real-render coverage for the prefix guide and its F1 reference view. */

import { afterEach, describe, expect, it } from "bun:test"
import { PrefixHud } from "../../src/tui-react/component/prefix-hud"
import { useFocus } from "../../src/tui-react/context/focus"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { useWorkspaceKeybindings } from "../../src/tui-react/workspace/host-keybindings"
import { PREFIX_GUIDE_DELAY_MS, prefixHudPush, prefixHudSetArmed, resetPrefixHud } from "../../src/tui/lib/prefix-hud"
import { act, renderComponent, settle } from "./harness"

const NOOP = (): void => {}

function WorkspaceHelpDriver() {
  const focus = useFocus()
  const dialog = useDialog()
  useWorkspaceKeybindings({
    focus,
    dialog,
    settingsOpen: false,
    worktreesOpen: false,
    openWorktrees: NOOP,
    updateOpen: false,
    openUpdate: NOOP,
    kanbanOpen: false,
    openKanban: NOOP,
    filesPaneVisible: true,
    automationsOpen: false,
    openAutomations: NOOP,
    workItemsOpen: false,
    openWorkItems: NOOP,
    searchActive: false,
    selectedId: null,
    openTaskWorktree: NOOP,
    openSettings: NOOP,
    closeSettings: NOOP,
    createTask: NOOP,
    renameBranch: NOOP,
    cycleVendor: NOOP,
    toggleZen: NOOP,
    jumpToNextAttention: NOOP,
    openInbox: NOOP,
    enterMoveMode: NOOP,
    createPR: NOOP,
  })
  return <text>workspace base</text>
}

afterEach(() => act(() => resetPrefixHud()))

describe("F1 keyboard reference", () => {
  it("opens from the workspace stack and leads with focus-aware grammar", async () => {
    const { frame, mockInput } = await renderComponent(<WorkspaceHelpDriver />, {
      width: 110,
      height: 36,
      providers: { focus: true, dialog: true },
    })

    act(() => mockInput.pressKey("F1"))
    await settle()
    const text = await frame()
    expect(text).toContain("kobe — keybindings")
    expect(text).toContain("Focused: Sidebar")
    expect(text).toContain("ONE PRESS")
    expect(text).toContain("AFTER PREFIX")
  })
})

describe("which-key prefix guide", () => {
  it("stays compact for a fast sequence", async () => {
    prefixHudSetArmed(true, [{ stroke: "f", action: "chat.fork.new" }], Date.now() + 10_000)
    const { frame } = await renderComponent(<PrefixHud left={1} width={22} />, { width: 80, height: 24 })
    const text = await frame()
    expect(text).toContain("ctrl+a ⋯")
    expect(text).not.toContain("more Kobe commands")
  })

  it("expands reachable commands after the learner delay", async () => {
    prefixHudSetArmed(
      true,
      [
        { stroke: "f", action: "chat.fork.new" },
        { stroke: "p", action: "files.createPR" },
        { stroke: "P", action: "files.createPR" },
        { stroke: "1", action: "kanban.open" },
        { stroke: ",", action: "settings.open.sidebar" },
      ],
      Date.now() - PREFIX_GUIDE_DELAY_MS,
    )
    const { frame } = await renderComponent(<PrefixHud left={1} width={22} />, { width: 120, height: 30 })
    const text = await frame()
    expect(text).toContain("ctrl+a — more Kobe commands")
    expect(text).toContain("Views")
    expect(text).toContain("Tasks")
    expect(text).toContain("Tools")
    expect(text).toContain("p/P")
    expect(text).toContain("Create PR")
  })

  it("renders the resolved-action feed on the readable dialog surface", async () => {
    prefixHudPush({ prefixKey: "ctrl+a", stroke: "f", action: "chat.fork.new", at: Date.now() })
    const { frame, spans } = await renderComponent(<PrefixHud left={1} width={28} />, { width: 80, height: 24 })
    expect(await frame()).toContain("ctrl+a + f")
    const backgrounds = (await spans()).lines.flatMap((line) => line.spans).filter((span) => span.bg !== undefined)
    expect(backgrounds.length).toBeGreaterThan(0)
  })
})
