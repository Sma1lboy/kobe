import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  detectWorktreeOpener: vi.fn(),
  openWorktree: vi.fn(),
}))

vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }))
vi.mock("../../src/tui/lib/worktree-opener", () => ({
  detectWorktreeOpener: mocks.detectWorktreeOpener,
  openWorktree: mocks.openWorktree,
}))

const { requestTaskWorktreeOpen } = await import("../../src/tui-react/workspace/open-task-worktree")

function deps(overrides: Record<string, unknown> = {}) {
  return {
    taskPath: "/worktree",
    ensureWorktree: vi.fn(async () => "/ensured"),
    notifyError: vi.fn(),
    noEditorMessage: "No editor",
    openFailedMessage: (label: string) => `Failed: ${label}`,
    ...overrides,
  }
}

describe("requestTaskWorktreeOpen", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.existsSync.mockReturnValue(true)
    mocks.detectWorktreeOpener.mockReturnValue({ label: "VS Code" })
    mocks.openWorktree.mockReturnValue(true)
  })

  test("opens an existing worktree", async () => {
    const options = deps()

    await requestTaskWorktreeOpen("task-1", options)

    expect(options.ensureWorktree).not.toHaveBeenCalled()
    expect(mocks.openWorktree).toHaveBeenCalledWith("/worktree", { label: "VS Code" })
  })

  test("ensures a missing worktree before opening it", async () => {
    mocks.existsSync.mockImplementation((path) => path === "/ensured")
    const options = deps({ taskPath: undefined })

    await requestTaskWorktreeOpen("task-1", options)

    expect(options.ensureWorktree).toHaveBeenCalledWith("task-1")
    expect(mocks.openWorktree).toHaveBeenCalledWith("/ensured", { label: "VS Code" })
  })

  test("reports worktree creation failures", async () => {
    const options = deps({
      taskPath: undefined,
      ensureWorktree: vi.fn(async () => {
        throw new Error("disk full")
      }),
    })

    await requestTaskWorktreeOpen("task-1", options)

    expect(options.notifyError).toHaveBeenCalledWith("Couldn't create worktree: disk full")
    expect(mocks.openWorktree).not.toHaveBeenCalled()
  })

  test("does nothing when the ensured path is still absent", async () => {
    mocks.existsSync.mockReturnValue(false)
    const options = deps({ taskPath: undefined })

    await requestTaskWorktreeOpen("task-1", options)

    expect(mocks.detectWorktreeOpener).not.toHaveBeenCalled()
  })

  test("reports a missing editor and launch failure", async () => {
    const noEditor = deps()
    mocks.detectWorktreeOpener.mockReturnValueOnce(null)
    await requestTaskWorktreeOpen("task-1", noEditor)
    expect(noEditor.notifyError).toHaveBeenCalledWith("No editor")

    const launchFailure = deps()
    mocks.openWorktree.mockReturnValueOnce(false)
    await requestTaskWorktreeOpen("task-1", launchFailure)
    expect(launchFailure.notifyError).toHaveBeenCalledWith("Failed: VS Code")
  })
})
