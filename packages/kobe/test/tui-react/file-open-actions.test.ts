/**
 * FileTree's two open actions (src/tui-react/workspace/use-file-open-actions).
 *
 * Despite the `use` prefix these are plain closures — no React hooks — so they
 * run under vitest directly. What's pinned here is the resolution ORDER
 * (plugin > editor tab > OS opener), the stale-continuation guard that keeps a
 * slow editor resolve from delivering into whatever task the user switched to,
 * and KOB-25's rule that a read-only diff must not steal focus.
 */

import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  tryPluginFileOpen: vi.fn(),
  resolveEditorLaunch: vi.fn(),
  openExternally: vi.fn(),
}))

vi.mock("../../src/tui-react/workspace/plugin-file-open", () => ({
  tryPluginFileOpen: mocks.tryPluginFileOpen,
}))
vi.mock("../../src/tui/lib/editor-launch.ts", () => ({ resolveEditorLaunch: mocks.resolveEditorLaunch }))
vi.mock("../../src/tui/panes/filetree/open-external", () => ({ openExternally: mocks.openExternally }))

const { useFileOpenActions } = await import("../../src/tui-react/workspace/use-file-open-actions")

type Deps = Parameters<typeof useFileOpenActions>[0]

function setup(overrides: Partial<Deps> = {}) {
  const openEditorTab = vi.fn()
  const openDiffTab = vi.fn()
  const setFocused = vi.fn()
  const reportUiEvent = vi.fn()
  const deps = {
    orch: { reportUiEvent } as unknown as Deps["orch"],
    worktree: "/wt",
    selectedId: "task-1",
    focus: { focused: "files", isFocused: () => false, setFocused } as unknown as Deps["focus"],
    openEditorTabFn: { current: openEditorTab },
    openDiffTabFn: { current: openDiffTab },
    selectedWorktreeRef: { current: "/wt" },
    ...overrides,
  } as Deps
  return { actions: useFileOpenActions(deps), openEditorTab, openDiffTab, setFocused, reportUiEvent, deps }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.tryPluginFileOpen.mockReturnValue(false)
  mocks.resolveEditorLaunch.mockResolvedValue({ command: "vim /wt/a.ts", label: "a.ts" })
})

describe("openFileInEditor", () => {
  test("a plugin handler wins over the editor and the OS opener", async () => {
    mocks.tryPluginFileOpen.mockReturnValue(true)
    const { actions, openEditorTab } = setup()
    await actions.openFileInEditor("a.ts")
    expect(openEditorTab).not.toHaveBeenCalled()
    expect(mocks.openExternally).not.toHaveBeenCalled()
    expect(mocks.resolveEditorLaunch).not.toHaveBeenCalled()
  })

  test("opens the editor tab and pulls focus to the workspace", async () => {
    const { actions, openEditorTab, setFocused } = setup()
    await actions.openFileInEditor("a.ts")
    expect(openEditorTab).toHaveBeenCalledWith(["sh", "-c", "vim /wt/a.ts"], "a.ts")
    expect(setFocused).toHaveBeenCalledWith("workspace")
  })

  test("falls back to the OS opener when no editor launch resolves", async () => {
    mocks.resolveEditorLaunch.mockResolvedValue(null)
    const { actions, openEditorTab } = setup()
    await actions.openFileInEditor("a.ts")
    expect(mocks.openExternally).toHaveBeenCalledWith("/wt/a.ts")
    expect(openEditorTab).not.toHaveBeenCalled()
  })

  test("no worktree selected is a no-op", async () => {
    const { actions, openEditorTab, reportUiEvent } = setup({ worktree: null })
    await actions.openFileInEditor("a.ts")
    expect(openEditorTab).not.toHaveBeenCalled()
    expect(reportUiEvent).not.toHaveBeenCalled()
  })

  // The bug this guard exists for: the user switches tasks while the editor
  // resolve is in flight, and the file lands in the NEW task's tab.
  test("drops the continuation when the selected worktree changed mid-resolve", async () => {
    const selectedWorktreeRef = { current: "/wt" }
    mocks.resolveEditorLaunch.mockImplementation(async () => {
      selectedWorktreeRef.current = "/other-wt"
      return { command: "vim /wt/a.ts", label: "a.ts" }
    })
    const { actions, openEditorTab, setFocused } = setup({ selectedWorktreeRef })
    await actions.openFileInEditor("a.ts")
    expect(openEditorTab).not.toHaveBeenCalled()
    expect(setFocused).not.toHaveBeenCalled()
  })

  test("drops the continuation when the tab mount was re-handed mid-resolve", async () => {
    const openEditorTabFn = { current: vi.fn() }
    const stale = openEditorTabFn.current
    mocks.resolveEditorLaunch.mockImplementation(async () => {
      openEditorTabFn.current = vi.fn()
      return { command: "vim /wt/a.ts", label: "a.ts" }
    })
    const { actions } = setup({ openEditorTabFn })
    await actions.openFileInEditor("a.ts")
    expect(stale).not.toHaveBeenCalled()
    expect(openEditorTabFn.current).not.toHaveBeenCalled()
  })
})

describe("openDiff", () => {
  test("labels the tab with the basename and passes the base through", () => {
    const { actions, openDiffTab } = setup()
    actions.openDiff("src/deep/a.ts", "main")
    expect(openDiffTab).toHaveBeenCalledWith("src/deep/a.ts", "a.ts", "main")
  })

  // KOB-25: a read-only open is a content swap, not a navigation.
  test("does not pull focus", () => {
    const { actions, setFocused } = setup()
    actions.openDiff("a.ts")
    expect(setFocused).not.toHaveBeenCalled()
  })
})
