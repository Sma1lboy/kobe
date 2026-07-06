/**
 * Shared task-action flow tests (`src/tui/lib/task-actions.ts`).
 *
 * Why these matter: the flows are the ONE implementation behind both the
 * deprecated outer monitor (app.tsx) and the Tasks pane (tasks-pane/host.tsx),
 * so a regression here breaks task lifecycle in every host at once. The two
 * load-bearing branches under test:
 *
 *   - delete's DIRTY_WORKTREE re-prompt — the guard that keeps a worktree
 *     with uncommitted work from being destroyed without an explicit
 *     force-confirm (KOB-244). A failed/declined delete must leave the tmux
 *     session and selection untouched.
 *   - archive's session teardown — archiving stops the running engine
 *     (switch-client away, optionally clear active-task focus, kill the tmux
 *     session) while unarchive touches nothing.
 *
 * The module deliberately has no `@opentui` imports: modal UI arrives as
 * context adapters (`confirm`, `promptText`), so the flows run here with
 * plain mocks. Only the tmux session ops are module-mocked.
 */

import { beforeEach, describe, expect, test, vi } from "vitest"
import { DIRTY_WORKTREE_CODE } from "../../src/orchestrator/errors"
import { killSession, switchClientBeforeKill } from "../../src/tui/panes/terminal/tmux"

vi.mock("../../src/tui/panes/terminal/tmux", () => ({
  tmuxSessionName: (id: string) => `kobe-${id}`,
  killSession: vi.fn(async () => {}),
  switchClientBeforeKill: vi.fn(async () => {}),
}))
// Rename/branch/vendor flows live in task-actions-rename.test.ts (file split
// to stay under the ~500-line cap).

import type { KobeOrchestrator } from "../../src/client/remote-orchestrator"
import { type TaskActionContext, archiveTaskFlow, deleteTaskFlow, nextActiveTask } from "../../src/tui/lib/task-actions"
import type { Task } from "../../src/types/task"

function makeTask(overrides: Omit<Partial<Task>, "id"> & { id: string }): Task {
  return {
    title: overrides.id,
    repo: "/repo",
    branch: `kobe/${overrides.id}`,
    worktreePath: `/wt/${overrides.id}`,
    status: "todo",
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task
}

type OrchMock = {
  deleteTask: ReturnType<typeof vi.fn>
  setArchived: ReturnType<typeof vi.fn>
  setActiveTask: ReturnType<typeof vi.fn>
  forgetProject: ReturnType<typeof vi.fn>
  setTitle: ReturnType<typeof vi.fn>
  setBranch: ReturnType<typeof vi.fn>
  setVendor: ReturnType<typeof vi.fn>
}

function makeOrch(overrides: Partial<OrchMock> = {}): OrchMock {
  return {
    deleteTask: vi.fn(async () => {}),
    setArchived: vi.fn(async () => {}),
    setActiveTask: vi.fn(async () => {}),
    forgetProject: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
    setBranch: vi.fn(async () => {}),
    setVendor: vi.fn(async () => {}),
    ...overrides,
  }
}

function makeCtx(opts: {
  tasks: readonly Task[]
  orch: OrchMock | null
  confirms?: readonly boolean[]
  switchBeforeKill?: boolean
  updateActiveTask?: boolean
  promptTextResult?: string | undefined
}): {
  ctx: TaskActionContext
  confirm: ReturnType<typeof vi.fn>
  promptText: ReturnType<typeof vi.fn>
  notifyError: ReturnType<typeof vi.fn>
  notifyInfo: ReturnType<typeof vi.fn>
  onTaskDeleted: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
} {
  const answers = [...(opts.confirms ?? [true])]
  const confirm = vi.fn(async () => answers.shift() ?? false)
  const promptText = vi.fn(async () => opts.promptTextResult)
  const notifyError = vi.fn()
  const notifyInfo = vi.fn()
  const onTaskDeleted = vi.fn()
  const reload = vi.fn(async () => {})
  const ctx: TaskActionContext = {
    orch: opts.orch as unknown as KobeOrchestrator | null,
    tasks: () => opts.tasks,
    confirm,
    promptText,
    logger: { error: vi.fn() },
    logPrefix: "[test]",
    notifyError,
    notifyInfo,
    reload,
    switchBeforeKill: opts.switchBeforeKill,
    updateActiveTask: opts.updateActiveTask,
    onTaskDeleted,
  }
  return { ctx, confirm, promptText, notifyError, notifyInfo, onTaskDeleted, reload }
}

beforeEach(() => {
  vi.mocked(killSession).mockClear()
  vi.mocked(switchClientBeforeKill).mockClear()
})

describe("nextActiveTask", () => {
  test("skips the excluded id and archived tasks", () => {
    const tasks = [makeTask({ id: "a", archived: true }), makeTask({ id: "b" }), makeTask({ id: "c" })]
    expect(nextActiveTask(tasks, "b")?.id).toBe("c")
  })
})

describe("deleteTaskFlow — dirty-worktree branch", () => {
  test("re-prompts on DIRTY_WORKTREE and force-deletes after explicit confirm", async () => {
    const tasks = [makeTask({ id: "t1", title: "dirty" }), makeTask({ id: "t2" })]
    const orch = makeOrch({
      deleteTask: vi.fn(async (_id: string, o?: { force?: boolean }) => {
        if (!o?.force) throw new Error(`refused: ${DIRTY_WORKTREE_CODE}`)
      }),
    })
    const { ctx, confirm, onTaskDeleted, reload } = makeCtx({ tasks, orch, confirms: [true, true] })

    await deleteTaskFlow(ctx, "t1")

    // Two confirms: the normal delete prompt, then the force re-prompt with
    // the uncommitted-changes copy — the copy is the contract both hosts share.
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls[1]?.[0]).toMatchObject({
      title: `"dirty" has uncommitted changes`,
      confirmLabel: "force delete",
    })
    expect(orch.deleteTask).toHaveBeenNthCalledWith(1, "t1")
    expect(orch.deleteTask).toHaveBeenNthCalledWith(2, "t1", { force: true })
    // Successful force-delete proceeds to teardown + host selection hook.
    expect(killSession).toHaveBeenCalledWith("kobe-t1")
    expect(reload).toHaveBeenCalledTimes(1)
    expect(onTaskDeleted).toHaveBeenCalledWith("t1", expect.objectContaining({ id: "t2" }))
  })

  test("declined force-delete leaves everything in place", async () => {
    const tasks = [makeTask({ id: "t1" })]
    const orch = makeOrch({
      deleteTask: vi.fn(async () => {
        throw new Error(`refused: ${DIRTY_WORKTREE_CODE}`)
      }),
    })
    const { ctx, onTaskDeleted } = makeCtx({ tasks, orch, confirms: [true, false] })

    await deleteTaskFlow(ctx, "t1")

    expect(orch.deleteTask).toHaveBeenCalledTimes(1)
    expect(killSession).not.toHaveBeenCalled()
    expect(onTaskDeleted).not.toHaveBeenCalled()
  })

  test("non-dirty failure surfaces a toast and skips teardown", async () => {
    const tasks = [makeTask({ id: "t1" })]
    const orch = makeOrch({
      deleteTask: vi.fn(async () => {
        throw new Error("daemon exploded")
      }),
    })
    const { ctx, confirm, notifyError, onTaskDeleted } = makeCtx({ tasks, orch, confirms: [true] })

    await deleteTaskFlow(ctx, "t1")

    // No force re-prompt for a non-DIRTY error.
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(notifyError).toHaveBeenCalledWith("Couldn't delete: daemon exploded")
    expect(killSession).not.toHaveBeenCalled()
    expect(onTaskDeleted).not.toHaveBeenCalled()
  })

  test("Tasks-pane divergence: switchBeforeKill switches the client away first", async () => {
    const tasks = [makeTask({ id: "t1" }), makeTask({ id: "t2" })]
    const orch = makeOrch()
    const { ctx } = makeCtx({ tasks, orch, confirms: [true], switchBeforeKill: true, updateActiveTask: true })

    await deleteTaskFlow(ctx, "t1")

    expect(switchClientBeforeKill).toHaveBeenCalledWith("kobe-t1", "kobe-t2")
    expect(orch.setActiveTask).toHaveBeenCalledWith("t2")
    expect(killSession).toHaveBeenCalledWith("kobe-t1")
  })
})

describe("deleteTaskFlow — project (main) row", () => {
  test("forgets the project instead of deleting, no worktree teardown", async () => {
    const tasks = [
      makeTask({ id: "m1", kind: "main", repo: "/repos/alpha", title: "alpha", worktreePath: "/repos/alpha" }),
    ]
    const orch = makeOrch()
    const { ctx, confirm, reload } = makeCtx({ tasks, orch, confirms: [true] })

    await deleteTaskFlow(ctx, "m1")

    // Project-specific copy (the "remove" verb, not "delete").
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ title: `Remove project "alpha"?`, confirmLabel: "remove" })
    expect(orch.forgetProject).toHaveBeenCalledWith("/repos/alpha")
    // Never routes to deleteTask (which refuses main rows) or kills a session.
    expect(orch.deleteTask).not.toHaveBeenCalled()
    expect(killSession).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test("declined confirm leaves the project in place", async () => {
    const tasks = [makeTask({ id: "m1", kind: "main", repo: "/repos/alpha" })]
    const orch = makeOrch()
    const { ctx } = makeCtx({ tasks, orch, confirms: [false] })

    await deleteTaskFlow(ctx, "m1")

    expect(orch.forgetProject).not.toHaveBeenCalled()
  })

  test("forget failure surfaces a toast and skips reload", async () => {
    const tasks = [makeTask({ id: "m1", kind: "main", repo: "/repos/alpha" })]
    const orch = makeOrch({
      forgetProject: vi.fn(async () => {
        throw new Error("daemon exploded")
      }),
    })
    const { ctx, notifyError, reload } = makeCtx({ tasks, orch, confirms: [true] })

    await deleteTaskFlow(ctx, "m1")

    expect(notifyError).toHaveBeenCalledWith("Couldn't remove: daemon exploded")
    expect(reload).not.toHaveBeenCalled()
  })
})

describe("archiveTaskFlow — session teardown", () => {
  test("archiving confirms, then kills the task's tmux session", async () => {
    const tasks = [makeTask({ id: "t1", title: "busy" }), makeTask({ id: "t2" })]
    const orch = makeOrch()
    const { ctx, confirm, reload } = makeCtx({ tasks, orch, confirms: [true], updateActiveTask: true })

    await archiveTaskFlow(ctx, "t1")

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: `Archive "busy"?`, confirmLabel: "archive" }))
    expect(orch.setArchived).toHaveBeenCalledWith("t1", true)
    // Archive STOPS the running engine: switch away, hand focus to the next
    // active task, kill the session. Data (worktree/branch/history) survives.
    expect(switchClientBeforeKill).toHaveBeenCalledWith("kobe-t1", "kobe-t2")
    expect(orch.setActiveTask).toHaveBeenCalledWith("t2")
    expect(killSession).toHaveBeenCalledWith("kobe-t1")
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test("declined confirm archives nothing and kills nothing", async () => {
    const tasks = [makeTask({ id: "t1" })]
    const orch = makeOrch()
    const { ctx } = makeCtx({ tasks, orch, confirms: [false] })

    await archiveTaskFlow(ctx, "t1")

    expect(orch.setArchived).not.toHaveBeenCalled()
    expect(killSession).not.toHaveBeenCalled()
  })

  test("unarchive needs no confirm and never touches tmux", async () => {
    const tasks = [makeTask({ id: "t1", archived: true })]
    const orch = makeOrch()
    const { ctx, confirm, reload } = makeCtx({ tasks, orch, confirms: [] })

    await archiveTaskFlow(ctx, "t1")

    expect(confirm).not.toHaveBeenCalled()
    expect(orch.setArchived).toHaveBeenCalledWith("t1", false)
    expect(switchClientBeforeKill).not.toHaveBeenCalled()
    expect(killSession).not.toHaveBeenCalled()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test("outer-monitor divergence: without updateActiveTask the shared focus is untouched", async () => {
    const tasks = [makeTask({ id: "t1" }), makeTask({ id: "t2" })]
    const orch = makeOrch()
    const { ctx } = makeCtx({ tasks, orch, confirms: [true] })

    await archiveTaskFlow(ctx, "t1")

    expect(orch.setActiveTask).not.toHaveBeenCalled()
    expect(killSession).toHaveBeenCalledWith("kobe-t1")
  })

  test("setArchived failure logs and skips teardown/reload entirely", async () => {
    const tasks = [makeTask({ id: "t1" })]
    const orch = makeOrch({
      setArchived: vi.fn(async () => {
        throw new Error("daemon down")
      }),
    })
    const { ctx, confirm, reload } = makeCtx({ tasks, orch, confirms: [true] })

    await archiveTaskFlow(ctx, "t1")

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(killSession).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  test("unknown taskId is a no-op", async () => {
    const tasks = [makeTask({ id: "t1" })]
    const orch = makeOrch()
    const { ctx, confirm } = makeCtx({ tasks, orch, confirms: [true] })

    await archiveTaskFlow(ctx, "does-not-exist")

    expect(confirm).not.toHaveBeenCalled()
    expect(orch.setArchived).not.toHaveBeenCalled()
  })

  test("no daemon (orch null) is a no-op", async () => {
    const tasks = [makeTask({ id: "t1" })]
    const { ctx, confirm } = makeCtx({ tasks, orch: null })

    await archiveTaskFlow(ctx, "t1")

    expect(confirm).not.toHaveBeenCalled()
  })
})

describe("deleteTaskFlow — misc guards", () => {
  test("unknown taskId is a no-op", async () => {
    const tasks = [makeTask({ id: "t1" })]
    const orch = makeOrch()
    const { ctx, confirm } = makeCtx({ tasks, orch, confirms: [true] })

    await deleteTaskFlow(ctx, "nope")

    expect(confirm).not.toHaveBeenCalled()
    expect(orch.deleteTask).not.toHaveBeenCalled()
  })

  test("no daemon (orch null) is a no-op", async () => {
    const tasks = [makeTask({ id: "t1" })]
    const { ctx, confirm } = makeCtx({ tasks, orch: null })

    await deleteTaskFlow(ctx, "t1")

    expect(confirm).not.toHaveBeenCalled()
  })
})
