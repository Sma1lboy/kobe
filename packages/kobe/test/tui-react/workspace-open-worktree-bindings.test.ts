import { describe, expect, test, vi } from "vitest"

// This test exercises the framework-free binding builder exported beside the
// hook. Mock the rendering shell so importing that module under Vitest does
// not load @opentui/react's Bun-only reconciler entrypoint.
vi.mock("@opentui/react", () => ({ useRenderer: vi.fn() }))
vi.mock("../../src/tui-react/component/help-dialog", () => ({ HelpDialog: { show: vi.fn() } }))
vi.mock("../../src/tui-react/i18n", () => ({ useT: () => (key: string) => key }))
vi.mock("../../src/tui-react/lib/keymap", () => ({ pageCloseBindings: vi.fn(), useBindings: vi.fn() }))
vi.mock("../../src/tui-react/ui/dialog-confirm", () => ({ DialogConfirm: { show: vi.fn() } }))

const { workspaceOpenWorktreeBindings } = await import("../../src/tui-react/workspace/host-keybindings")

describe("workspace open-worktree bindings", () => {
  test("global prefix-o and sidebar o open the selected task", () => {
    const openTaskWorktree = vi.fn()
    const bindings = workspaceOpenWorktreeBindings({ selectedId: "task-1", openTaskWorktree })

    expect(bindings.global.map(({ key, prefix }) => ({ key, prefix }))).toEqual([{ key: "o", prefix: true }])
    expect(bindings.sidebar.map(({ key, prefix }) => ({ key, prefix }))).toEqual([{ key: "o", prefix: undefined }])

    bindings.global[0]?.cmd({} as never)
    bindings.sidebar[0]?.cmd({} as never)
    expect(openTaskWorktree).toHaveBeenCalledTimes(2)
    expect(openTaskWorktree).toHaveBeenNthCalledWith(1, "task-1")
    expect(openTaskWorktree).toHaveBeenNthCalledWith(2, "task-1")
  })

  test("does nothing when no task is selected", () => {
    const openTaskWorktree = vi.fn()
    const bindings = workspaceOpenWorktreeBindings({ selectedId: null, openTaskWorktree })

    bindings.global[0]?.cmd({} as never)
    bindings.sidebar[0]?.cmd({} as never)
    expect(openTaskWorktree).not.toHaveBeenCalled()
  })
})
