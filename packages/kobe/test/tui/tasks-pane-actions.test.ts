/**
 * `tasks-pane/actions.ts` — the Tasks pane's action bodies, split out of
 * `tasks-pane/host.tsx` into a deps-bag module (mirrors
 * `settings-dialog/actions.ts`). Every function takes an explicit
 * `TasksHostActionsContext` instead of closing over Solid signals, so each
 * is testable here with plain mocks — no opentui rendering, no tmux.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { KVContext } from "../../src/tui/context/kv"
import type { Task } from "../../src/types/task"

function fakeKv(overrides: { get?: () => unknown; set?: () => void; flush?: () => boolean } = {}): KVContext {
  return {
    get: vi.fn(overrides.get ?? (() => undefined)),
    set: vi.fn(overrides.set ?? (() => {})),
    flush: vi.fn(overrides.flush ?? (() => true)),
  } as unknown as KVContext
}

const fake = vi.hoisted(() => ({
  session: "kobe-demo" as string | null,
  claudePane: "%3" as string | null,
  existsResult: true,
}))

vi.mock("../../src/tmux/client", () => ({
  claudePaneIdStrict: vi.fn(async () => fake.claudePane),
  currentSessionName: vi.fn(async () => fake.session),
  killSession: vi.fn(async () => {}),
  runTmux: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
  tmuxSessionName: vi.fn((id: string) => `kobe-${id}`),
}))
vi.mock("../../src/tui/component/help-dialog", () => ({
  HelpDialog: { show: vi.fn() },
}))
vi.mock("../../src/tui/component/new-task-dialog", () => ({
  NewTaskDialog: { show: vi.fn(async () => null) },
}))
vi.mock("../../src/tui/component/rename-task-dialog", () => ({
  RenameTaskDialog: { show: vi.fn(async () => null) },
}))
vi.mock("../../src/tui/component/settings-dialog", () => ({
  SettingsDialog: { show: vi.fn(async () => ({ visualPrefsChanged: false })) },
}))
vi.mock("../../src/tui/panes/terminal/tmux", () => ({
  openHelpTab: vi.fn(async () => {}),
  openNewTaskTab: vi.fn(async () => {}),
  openSettingsTab: vi.fn(async () => {}),
  openUpdateTab: vi.fn(async () => {}),
  openWorktreesTab: vi.fn(async () => {}),
  refreshKobeWorkspacePanes: vi.fn(async () => {}),
}))
vi.mock("../../src/tui/lib/task-enter.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tui/lib/task-enter.ts")>()
  return { ...actual, enterTask: vi.fn(async () => true) }
})
vi.mock("../../src/tui/lib/worktree-opener", () => ({
  detectWorktreeOpener: vi.fn(() => ({ label: "VS Code", command: "code" })),
  openWorktree: vi.fn(() => true),
}))
vi.mock("../../src/tui/ui/dialog-confirm", () => ({
  DialogConfirm: { show: vi.fn(async () => true) },
}))
vi.mock("../../src/state/repos.ts", () => ({
  getCustomEngineIds: vi.fn(() => []),
  getPersistedString: vi.fn(() => undefined),
  setPersistedString: vi.fn(() => {}),
}))
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, existsSync: vi.fn(() => fake.existsResult) }
})

const actions = await import("../../src/tui/tasks-pane/actions.ts")
const tmuxClient = await import("../../src/tmux/client")
const dialogTabs = await import("../../src/tui/panes/terminal/tmux")
const { HelpDialog } = await import("../../src/tui/component/help-dialog")
const { SettingsDialog } = await import("../../src/tui/component/settings-dialog")
const { NewTaskDialog } = await import("../../src/tui/component/new-task-dialog")
const { RenameTaskDialog } = await import("../../src/tui/component/rename-task-dialog")
const { DialogConfirm } = await import("../../src/tui/ui/dialog-confirm")
const { enterTask, HandoverError } = await import("../../src/tui/lib/task-enter.ts")
const { detectWorktreeOpener, openWorktree } = await import("../../src/tui/lib/worktree-opener")

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1" as Task["id"],
    title: "demo",
    repo: "/repo",
    branch: "feat/x",
    worktreePath: "/repo/.kobe/worktrees/feat-x",
    kind: "task",
    status: "idle",
    archived: false,
    ...overrides,
  } as Task
}

function makeCtx(overrides: Partial<Parameters<typeof actions.buildTaskActionsContext>[0]> = {}) {
  const notifyError = vi.fn()
  const notifyInfo = vi.fn()
  const reload = vi.fn(async () => {})
  const setSelectedId = vi.fn()
  const kv = fakeKv()
  const dialog = {} as never
  const ctx = {
    tasks: () => [makeTask()],
    orch: null,
    kv,
    dialog,
    notifyError,
    notifyInfo,
    reload,
    updateInfo: () => null,
    setSelectedId,
    ...overrides,
  }
  return { ctx, notifyError, notifyInfo, reload, setSelectedId, kv }
}

beforeEach(() => {
  fake.session = "kobe-demo"
  fake.claudePane = "%3"
  fake.existsResult = true
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("worktreeErrorToast", () => {
  test("maps a not-a-git-repository message to the friendly toast", () => {
    expect(actions.worktreeErrorToast(new Error("fatal: not a git repository"))).toMatch(/git/i)
  })
  test("falls back to a generic toast with the raw message", () => {
    const toast = actions.worktreeErrorToast(new Error("boom"))
    expect(toast).toContain("boom")
  })
})

describe("openSettingsAction", () => {
  test("chattab surface + resolvable session opens the tab, no dialog", async () => {
    const { ctx } = makeCtx({ kv: fakeKv({ get: () => "chattab" }) })
    await actions.openSettingsAction(ctx)
    expect(dialogTabs.openSettingsTab).toHaveBeenCalledWith("kobe-demo")
    expect(SettingsDialog.show).not.toHaveBeenCalled()
  })

  test("falls back to the overlay when no session resolves", async () => {
    fake.session = null
    const { ctx } = makeCtx({ kv: fakeKv({ get: () => "chattab" }) })
    await actions.openSettingsAction(ctx)
    expect(SettingsDialog.show).toHaveBeenCalled()
  })

  test("visualPrefsChanged + flush success refreshes workspace panes", async () => {
    vi.mocked(SettingsDialog.show).mockResolvedValueOnce({ visualPrefsChanged: true })
    const { ctx } = makeCtx({ kv: fakeKv({ get: () => "taskpanel", flush: () => true }) })
    await actions.openSettingsAction(ctx)
    expect(dialogTabs.refreshKobeWorkspacePanes).toHaveBeenCalledWith("kobe-demo")
  })

  test("visualPrefsChanged but flush() false skips the refresh", async () => {
    vi.mocked(SettingsDialog.show).mockResolvedValueOnce({ visualPrefsChanged: true })
    const { ctx } = makeCtx({ kv: fakeKv({ get: () => "taskpanel", flush: () => false }) })
    await actions.openSettingsAction(ctx)
    expect(dialogTabs.refreshKobeWorkspacePanes).not.toHaveBeenCalled()
  })
})

describe("openHelpAction", () => {
  test("opens the help tab when a session resolves", async () => {
    const { ctx } = makeCtx()
    await actions.openHelpAction(ctx)
    expect(dialogTabs.openHelpTab).toHaveBeenCalledWith("kobe-demo")
    expect(HelpDialog.show).not.toHaveBeenCalled()
  })

  test("falls back to the overlay with no session", async () => {
    fake.session = null
    const { ctx } = makeCtx()
    await actions.openHelpAction(ctx)
    expect(HelpDialog.show).toHaveBeenCalled()
  })
})

describe("openWorktreesAction", () => {
  test("opens the tab when a session resolves", async () => {
    await actions.openWorktreesAction()
    expect(dialogTabs.openWorktreesTab).toHaveBeenCalledWith("kobe-demo")
  })

  test("no-ops with no session", async () => {
    fake.session = null
    await actions.openWorktreesAction()
    expect(dialogTabs.openWorktreesTab).not.toHaveBeenCalled()
  })
})

describe("openUpdateAction", () => {
  test("no pending update surfaces the up-to-date toast", async () => {
    const { ctx, notifyInfo } = makeCtx()
    await actions.openUpdateAction(ctx)
    expect(notifyInfo).toHaveBeenCalledTimes(1)
    expect(dialogTabs.openUpdateTab).not.toHaveBeenCalled()
  })

  test("pending update opens the update tab", async () => {
    const { ctx } = makeCtx({ updateInfo: () => ({ hasUpdate: true, latest: "9.9.9" }) as never })
    await actions.openUpdateAction(ctx)
    expect(dialogTabs.openUpdateTab).toHaveBeenCalledWith("kobe-demo")
  })
})

describe("openSelectedWorktreeAction", () => {
  test("unknown task id no-ops without a daemon", async () => {
    const { ctx, notifyError } = makeCtx({ tasks: () => [] })
    await actions.openSelectedWorktreeAction(ctx, "missing")
    expect(notifyError).toHaveBeenCalled()
  })

  test("materialises via ensureWorktree, then opens with the detected editor", async () => {
    const ensureWorktree = vi.fn(async () => "/repo/.kobe/worktrees/feat-x")
    const { ctx, reload } = makeCtx({
      tasks: () => [makeTask({ worktreePath: "" })],
      orch: { ensureWorktree } as never,
    })
    await actions.openSelectedWorktreeAction(ctx, "t1")
    expect(ensureWorktree).toHaveBeenCalledWith("t1")
    expect(reload).toHaveBeenCalled()
    expect(openWorktree).toHaveBeenCalled()
  })

  test("ensureWorktree failure surfaces the mapped toast", async () => {
    const ensureWorktree = vi.fn(async () => {
      throw new Error("fatal: not a git repository")
    })
    const { ctx, notifyError } = makeCtx({
      tasks: () => [makeTask({ worktreePath: "" })],
      orch: { ensureWorktree } as never,
    })
    await actions.openSelectedWorktreeAction(ctx, "t1")
    expect(notifyError).toHaveBeenCalled()
  })

  test("no opener detected surfaces a toast", async () => {
    vi.mocked(detectWorktreeOpener).mockReturnValueOnce(null)
    const { ctx, notifyError } = makeCtx()
    await actions.openSelectedWorktreeAction(ctx, "t1")
    expect(notifyError).toHaveBeenCalled()
  })

  test("opener failure surfaces a toast", async () => {
    vi.mocked(openWorktree).mockReturnValueOnce(false)
    const { ctx, notifyError } = makeCtx()
    await actions.openSelectedWorktreeAction(ctx, "t1")
    expect(notifyError).toHaveBeenCalled()
  })
})

describe("focusEnginePaneAction", () => {
  const originalPane = process.env.TMUX_PANE

  afterEach(() => {
    if (originalPane === undefined) Reflect.deleteProperty(process.env, "TMUX_PANE")
    else process.env.TMUX_PANE = originalPane
  })

  test("no-ops outside tmux", async () => {
    Reflect.deleteProperty(process.env, "TMUX_PANE")
    await actions.focusEnginePaneAction()
    expect(tmuxClient.runTmux).not.toHaveBeenCalled()
  })

  test("selects the tagged engine pane when found", async () => {
    process.env.TMUX_PANE = "%1"
    await actions.focusEnginePaneAction()
    expect(tmuxClient.runTmux).toHaveBeenCalledWith(["select-pane", "-t", "%3"])
  })

  test("no-ops when no engine pane is tagged", async () => {
    process.env.TMUX_PANE = "%1"
    fake.claudePane = null
    await actions.focusEnginePaneAction()
    expect(tmuxClient.runTmux).not.toHaveBeenCalled()
  })
})

describe("moveTaskAction", () => {
  test("unknown task id no-ops", async () => {
    const { ctx, setSelectedId } = makeCtx({ tasks: () => [] })
    await actions.moveTaskAction(ctx, "t1", 1)
    expect(setSelectedId).not.toHaveBeenCalled()
  })

  test("main task no-ops", async () => {
    const { ctx, setSelectedId } = makeCtx({ tasks: () => [makeTask({ kind: "main" })] })
    await actions.moveTaskAction(ctx, "t1", 1)
    expect(setSelectedId).not.toHaveBeenCalled()
  })

  test("no daemon no-ops", async () => {
    const { ctx, setSelectedId } = makeCtx()
    await actions.moveTaskAction(ctx, "t1", 1)
    expect(setSelectedId).not.toHaveBeenCalled()
  })

  test("moveTask failure surfaces a toast and skips reselect", async () => {
    const moveTask = vi.fn(async () => {
      throw new Error("nope")
    })
    const { ctx, notifyError, setSelectedId } = makeCtx({ orch: { moveTask } as never })
    await actions.moveTaskAction(ctx, "t1", 1)
    expect(notifyError).toHaveBeenCalled()
    expect(setSelectedId).not.toHaveBeenCalled()
  })

  test("success reselects and reloads", async () => {
    const moveTask = vi.fn(async () => {})
    const { ctx, setSelectedId, reload } = makeCtx({ orch: { moveTask } as never })
    await actions.moveTaskAction(ctx, "t1", 1)
    expect(setSelectedId).toHaveBeenCalledWith("t1")
    expect(reload).toHaveBeenCalled()
  })
})

describe("togglePinAction", () => {
  test("no daemon no-ops", async () => {
    const { ctx, reload } = makeCtx()
    await actions.togglePinAction(ctx, "t1")
    expect(reload).not.toHaveBeenCalled()
  })

  test("setPinned failure logs and skips reload", async () => {
    const setPinned = vi.fn(async () => {
      throw new Error("nope")
    })
    const { ctx, reload } = makeCtx({ orch: { setPinned } as never })
    await actions.togglePinAction(ctx, "t1")
    expect(reload).not.toHaveBeenCalled()
  })

  test("success reloads", async () => {
    const setPinned = vi.fn(async () => {})
    const { ctx, reload } = makeCtx({ orch: { setPinned } as never })
    await actions.togglePinAction(ctx, "t1")
    expect(reload).toHaveBeenCalled()
  })
})

describe("switchToAction", () => {
  test("unknown task id no-ops", async () => {
    const { ctx } = makeCtx({ tasks: () => [] })
    await actions.switchToAction(ctx, { token: 0 }, "t1")
    expect(enterTask).not.toHaveBeenCalled()
  })

  test("success calls enterTask without surfacing a toast", async () => {
    const { ctx, notifyError } = makeCtx()
    await actions.switchToAction(ctx, { token: 0 }, "t1")
    expect(enterTask).toHaveBeenCalled()
    expect(notifyError).not.toHaveBeenCalled()
  })

  test("no-daemon HandoverError maps to the no-daemon toast", async () => {
    vi.mocked(enterTask).mockRejectedValueOnce(new HandoverError("no-daemon", "no daemon"))
    const { ctx, notifyError } = makeCtx()
    await actions.switchToAction(ctx, { token: 0 }, "t1")
    expect(notifyError).toHaveBeenCalledTimes(1)
  })

  test("worktree HandoverError maps to the worktree toast", async () => {
    vi.mocked(enterTask).mockRejectedValueOnce(new HandoverError("worktree", "bad worktree", new Error("boom")))
    const { ctx, notifyError } = makeCtx()
    await actions.switchToAction(ctx, { token: 0 }, "t1")
    expect(notifyError).toHaveBeenCalledTimes(1)
  })

  test("session-phase HandoverError maps to the generic session toast", async () => {
    vi.mocked(enterTask).mockRejectedValueOnce(new HandoverError("session", "session boom"))
    const { ctx, notifyError } = makeCtx()
    await actions.switchToAction(ctx, { token: 0 }, "t1")
    expect(notifyError).toHaveBeenCalledTimes(1)
  })

  test("a non-HandoverError is logged, not surfaced as a toast", async () => {
    vi.mocked(enterTask).mockRejectedValueOnce(new Error("weird"))
    const { ctx, notifyError } = makeCtx()
    await actions.switchToAction(ctx, { token: 0 }, "t1")
    expect(notifyError).not.toHaveBeenCalled()
  })
})

describe("togglePreviewFlowAction", () => {
  test("toggles preview mode, kills the session, and switches back in", async () => {
    const { ctx } = makeCtx()
    await actions.togglePreviewFlowAction(ctx, { token: 0 }, "t1")
    expect(tmuxClient.killSession).toHaveBeenCalledWith("kobe-t1")
    expect(enterTask).toHaveBeenCalled()
  })
})

describe("buildTaskActionsContext", () => {
  test("wires confirm/promptText/cursorRepo/vendor persistence/selection through to the deps", async () => {
    const switchTo = vi.fn(async () => {})
    const selectedId = vi.fn(() => "t1")
    const setSelectedId = vi.fn()
    const { ctx } = makeCtx()
    const taskActions = actions.buildTaskActionsContext({ ...ctx, selectedId, setSelectedId, switchTo })

    await expect(taskActions.confirm({ title: "t", body: "b", cancelLabel: "no", confirmLabel: "yes" })).resolves.toBe(
      true,
    )
    expect(DialogConfirm.show).toHaveBeenCalled()

    await taskActions.promptText("init", {})
    expect(RenameTaskDialog.show).toHaveBeenCalled()

    expect(taskActions.cursorRepo()).toBe("/repo")

    expect(taskActions.lastVendor("/repo")).toBeDefined()
    taskActions.rememberVendor("/repo", "claude" as never)

    taskActions.selectTask!("t2")
    expect(setSelectedId).toHaveBeenCalledWith("t2")

    await taskActions.enterTask!("t2")
    expect(switchTo).toHaveBeenCalledWith("t2")

    await taskActions.promptNewTask("/repo", [], {})
    expect(NewTaskDialog.show).toHaveBeenCalled()
  })

  test("onTaskDeleted reselects only when the deleted task was selected", () => {
    const setSelectedId = vi.fn()
    const { ctx } = makeCtx({ tasks: () => [makeTask({ id: "t2" as Task["id"] })] })
    const taskActions = actions.buildTaskActionsContext({
      ...ctx,
      selectedId: () => "t1",
      setSelectedId,
      switchTo: vi.fn(async () => {}),
    })
    taskActions.onTaskDeleted?.("other", undefined)
    expect(setSelectedId).not.toHaveBeenCalled()

    const selected = actions.buildTaskActionsContext({
      ...ctx,
      selectedId: () => "t1",
      setSelectedId,
      switchTo: vi.fn(async () => {}),
    })
    selected.onTaskDeleted?.("t1", undefined)
    expect(setSelectedId).toHaveBeenCalledWith("t2")
  })

  test("openCreateSurface opens the chattab surface only when resolvable", async () => {
    const { ctx } = makeCtx({ kv: fakeKv({ get: () => "chattab" }) })
    const taskActions = actions.buildTaskActionsContext({
      ...ctx,
      selectedId: () => null,
      setSelectedId: vi.fn(),
      switchTo: vi.fn(async () => {}),
    })
    await expect(taskActions.openCreateSurface!("/repo")).resolves.toBe(true)
    expect(dialogTabs.openNewTaskTab).toHaveBeenCalledWith("kobe-demo", "/repo")

    const { ctx: overlayCtx } = makeCtx({ kv: fakeKv({ get: () => "taskpanel" }) })
    const overlayActions = actions.buildTaskActionsContext({
      ...overlayCtx,
      selectedId: () => null,
      setSelectedId: vi.fn(),
      switchTo: vi.fn(async () => {}),
    })
    await expect(overlayActions.openCreateSurface!("/repo")).resolves.toBe(false)
  })
})
