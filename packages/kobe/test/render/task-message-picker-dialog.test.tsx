/** @jsxImportSource @opentui/react */

import { describe, expect, it } from "bun:test"
import { TaskMessagePickerView } from "../../src/tui-react/component/task-message-picker-dialog"
import { type WorkspaceKeybindingDeps, useWorkspaceKeybindings } from "../../src/tui-react/workspace/host-keybindings"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { act, renderComponent, settle } from "./harness"

function task(id: string, title: string, overrides: Partial<Task> = {}): Task {
  return {
    id: toTaskId(id),
    title,
    repo: "/repo",
    worktreePath: `/repo/${id}`,
    branch: id,
    status: "in_progress",
    archived: false,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  }
}

function MessageKeybindingDriver(props: { onChoose: () => void }) {
  const deps: WorkspaceKeybindingDeps = {
    focus: { focused: "workspace", setFocused: () => {} } as never,
    dialog: { stack: [] } as never,
    settingsOpen: false,
    worktreesOpen: false,
    openWorktrees: () => {},
    updateOpen: false,
    openUpdate: () => {},
    kanbanOpen: false,
    openKanban: () => {},
    filesPaneVisible: true,
    automationsOpen: false,
    openAutomations: () => {},
    workItemsOpen: false,
    openWorkItems: () => {},
    searchActive: false,
    selectedId: "SELF01",
    openTaskWorktree: () => {},
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
    chooseMessagePeer: props.onChoose,
  }
  useWorkspaceKeybindings(deps)
  return <text>workspace ready</text>
}

describe("TaskMessagePickerView", () => {
  it("shows only addressable peer tasks", async () => {
    const current = task("SELF01", "primary")
    const { frame } = await renderComponent(
      <TaskMessagePickerView
        current={current}
        tasks={[
          current,
          task("PEER02", "worker"),
          task("OLD003", "archived", { archived: true }),
          task("EMPTY4", "missing worktree", { worktreePath: "" }),
        ]}
        onSubmit={() => {}}
      />,
      { width: 72, height: 20, providers: { dialog: true } },
    )

    const text = await frame()
    expect(text).toContain("worker")
    expect(text).not.toContain("archived")
    expect(text).not.toContain("missing worktree")
  })

  it("moves the cursor and submits the highlighted peer", async () => {
    const current = task("SELF01", "primary")
    const peers = [task("PEER02", "first peer"), task("PEER03", "second peer")]
    let selected: Task | undefined
    const { frame, mockInput } = await renderComponent(
      <TaskMessagePickerView
        current={current}
        tasks={[current, ...peers]}
        onSubmit={(task) => {
          selected = task
        }}
      />,
      { width: 72, height: 20, providers: { dialog: true } },
    )

    expect(await frame()).toContain("first peer")
    act(() => mockInput.pressArrow("down"))
    await settle()
    act(() => mockInput.pressEnter())
    await settle()

    expect(selected?.id).toBe(peers[1]?.id)
  })

  it("renders an explicit empty state when no peer can be addressed", async () => {
    const current = task("SELF01", "primary")
    const { frame } = await renderComponent(
      <TaskMessagePickerView current={current} tasks={[current]} onSubmit={() => {}} />,
      { width: 72, height: 20, providers: { dialog: true } },
    )

    expect(await frame()).toContain("No other available tasks")
  })
})

describe("task-message workspace binding", () => {
  it("dispatches prefix+@ to the peer picker", async () => {
    let chosen = 0
    const { frame, mockInput } = await renderComponent(<MessageKeybindingDriver onChoose={() => chosen++} />, {
      width: 50,
      height: 10,
    })
    expect(await frame()).toContain("workspace ready")

    act(() => mockInput.pressKey("a", { ctrl: true }))
    await settle()
    act(() => mockInput.pressKey("@"))
    await settle()

    expect(chosen).toBe(1)
  })
})
