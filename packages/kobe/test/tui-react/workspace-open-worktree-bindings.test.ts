import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  bindingFactories: [] as Array<
    () => {
      enabled: boolean
      bindings: Array<{ key: string; prefix?: boolean; cmd: (event: never) => void }>
    }
  >,
}))

// This test exercises the framework-free binding builder exported beside the
// hook. Mock the rendering shell so importing that module under Vitest does
// not load @opentui/react's Bun-only reconciler entrypoint.
vi.mock("@opentui/react", () => ({ useRenderer: vi.fn() }))
vi.mock("../../src/tui-react/component/help-dialog", () => ({ HelpDialog: { show: vi.fn() } }))
vi.mock("../../src/tui-react/i18n", () => ({ useT: () => (key: string) => key }))
vi.mock("../../src/tui-react/lib/keymap", () => ({
  pageCloseBindings: vi.fn(() => []),
  useBindings: vi.fn((factory) => mocks.bindingFactories.push(factory)),
}))
vi.mock("../../src/tui-react/ui/dialog-confirm", () => ({ DialogConfirm: { show: vi.fn() } }))

const { useWorkspaceKeybindings } = await import("../../src/tui-react/workspace/host-keybindings")

describe("workspace open-worktree bindings", () => {
  beforeEach(() => {
    mocks.bindingFactories.length = 0
  })

  test("the workspace hook registers both open-worktree bindings", () => {
    const openTaskWorktree = vi.fn()
    const renameBranch = vi.fn()
    const cycleVendor = vi.fn()
    useWorkspaceKeybindings({
      focus: { focused: "sidebar", setFocused: vi.fn() } as never,
      dialog: { stack: [] } as never,
      settingsOpen: false,
      worktreesOpen: false,
      openWorktrees: vi.fn(),
      updateOpen: false,
      openUpdate: vi.fn(),
      kanbanOpen: false,
      openKanban: vi.fn(),
      searchActive: false,
      selectedId: "task-1",
      openTaskWorktree,
      openSettings: vi.fn(),
      closeSettings: vi.fn(),
      createTask: vi.fn(),
      renameBranch,
      cycleVendor,
      toggleZen: vi.fn(),
      jumpToNextAttention: vi.fn(),
      openInbox: vi.fn(),
      enterMoveMode: vi.fn(),
      createPR: vi.fn(),
    })

    const registrations = mocks.bindingFactories.map((factory) => factory())
    const globalOpen = registrations[0]?.bindings.find((binding) => binding.key === "o" && binding.prefix)
    const sidebarBindings = registrations[3]?.bindings ?? []
    const sidebarOpen = sidebarBindings.find((binding) => binding.key === "o" && !binding.prefix)
    const rename = sidebarBindings.find((binding) => binding.key === "b")
    const cycleEngine = sidebarBindings.find((binding) => binding.key === "v")

    expect(globalOpen).toBeDefined()
    expect(sidebarOpen).toBeDefined()
    expect(rename).toBeDefined()
    expect(cycleEngine).toBeDefined()
    globalOpen?.cmd({} as never)
    sidebarOpen?.cmd({} as never)
    rename?.cmd({} as never)
    cycleEngine?.cmd({} as never)
    expect(openTaskWorktree).toHaveBeenCalledTimes(2)
    expect(renameBranch).toHaveBeenCalledWith("task-1")
    expect(cycleVendor).toHaveBeenCalledWith("task-1")
  })
})
