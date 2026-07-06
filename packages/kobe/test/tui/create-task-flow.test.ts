import { describe, expect, test, vi } from "vitest"

vi.mock("../../src/tui/panes/terminal/tmux", () => ({
  tmuxSessionName: (id: string) => `kobe-${id}`,
  killSession: vi.fn(async () => {}),
  switchClientBeforeKill: vi.fn(async () => {}),
}))
vi.mock("../../src/state/repos", () => ({
  getSavedRepos: () => ["/repo"],
  addSavedRepo: vi.fn(() => ({ added: false, path: "/repo", total: 1 })),
}))
vi.mock("../../src/engine/account-detect", () => ({
  availableEngineIds: () => mockAvailableEngineIds(),
}))
const mockAvailableEngineIds = vi.fn(async () => ["claude"])

import type { KobeOrchestrator } from "../../src/client/remote-orchestrator"
import type { NewTaskInput } from "../../src/tui/component/new-task-dialog"
import { type CreateTaskContext, createTaskFlow } from "../../src/tui/lib/task-actions"

type AdoptItem = { worktreePath: string; branch: string }

function makeCreateCtx(opts: {
  adopt?: readonly AdoptItem[]
  adoptWorktree?: (input: { worktreePath: string }) => Promise<{ id: string }>
  createTask?: (input: { repo: string; baseRef?: string; vendor: unknown }) => Promise<{ id: string }>
  promptNewTask?: () => Promise<NewTaskInput | undefined>
  openCreateSurface?: (defaultRepo: string) => Promise<boolean>
  orch?: KobeOrchestrator | null
}): {
  ctx: CreateTaskContext
  notifyInfo: ReturnType<typeof vi.fn>
  notifyError: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  selectTask: ReturnType<typeof vi.fn>
  enterTask: ReturnType<typeof vi.fn>
  adoptWorktree: ReturnType<typeof vi.fn>
  createTask: ReturnType<typeof vi.fn>
  rememberVendor: ReturnType<typeof vi.fn>
  logger: { error: ReturnType<typeof vi.fn> }
} {
  const notifyInfo = vi.fn()
  const notifyError = vi.fn()
  const reload = vi.fn(async () => {})
  const selectTask = vi.fn()
  const enterTask = vi.fn(async () => {})
  const adoptWorktree = vi.fn(opts.adoptWorktree ?? (async ({ worktreePath }) => ({ id: worktreePath })))
  const createTask = vi.fn(opts.createTask ?? (async () => ({ id: "created-id" })))
  const rememberVendor = vi.fn()
  const logger = { error: vi.fn() }
  const innerOrch = {
    adoptWorktree,
    createTask,
    discoverAdoptableWorktrees: vi.fn(async () => []),
  } as unknown as KobeOrchestrator
  const orch = opts.orch === undefined ? innerOrch : opts.orch
  const ctx: CreateTaskContext = {
    orch,
    tasks: () => [],
    confirm: async () => true,
    promptText: async () => undefined,
    logger,
    logPrefix: "[test]",
    notifyInfo,
    notifyError,
    reload,
    selectTask,
    enterTask,
    cursorRepo: () => "/repo",
    lastVendor: () => "claude" as never,
    rememberVendor,
    openCreateSurface: opts.openCreateSurface,
    promptNewTask:
      opts.promptNewTask ??
      (async () => ({ mode: "adopt", repo: "/repo", vendor: "claude" as never, adopt: opts.adopt ?? [] })),
  }
  return {
    ctx,
    notifyInfo,
    notifyError,
    reload,
    selectTask,
    enterTask,
    adoptWorktree,
    createTask,
    rememberVendor,
    logger,
  }
}

describe("createTaskFlow — adopt summary", () => {
  test("all adopted: info summary + focuses the last one", async () => {
    const adopt = [
      { worktreePath: "/wt/a", branch: "a" },
      { worktreePath: "/wt/b", branch: "b" },
    ]
    const { ctx, notifyInfo, notifyError, reload, selectTask, enterTask } = makeCreateCtx({
      adopt,
      adoptWorktree: async ({ worktreePath }) => ({ id: worktreePath === "/wt/a" ? "id-a" : "id-b" }),
    })

    await createTaskFlow(ctx)

    expect(notifyError).not.toHaveBeenCalled()
    const summary = notifyInfo.mock.calls.map((c) => String(c[0]))
    expect(summary.some((m) => /2/.test(m))).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(selectTask).toHaveBeenCalledWith("id-b")
    expect(enterTask).toHaveBeenCalledWith("id-b")
  })

  test("partial: one fails — the succeeded task still surfaces (N/M summary, not a generic error)", async () => {
    const adopt = [
      { worktreePath: "/wt/ok", branch: "ok" },
      { worktreePath: "/wt/bad", branch: "bad" },
    ]
    const { ctx, notifyInfo, notifyError, reload, selectTask, enterTask } = makeCreateCtx({
      adopt,
      adoptWorktree: async ({ worktreePath }) => {
        if (worktreePath === "/wt/bad") throw new Error("boom")
        return { id: "id-ok" }
      },
    })

    await createTaskFlow(ctx)

    expect(notifyError).not.toHaveBeenCalled()
    const summary = notifyInfo.mock.calls.map((c) => String(c[0]))
    expect(summary.some((m) => /1\/2/.test(m))).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(selectTask).toHaveBeenCalledWith("id-ok")
    expect(enterTask).toHaveBeenCalledWith("id-ok")
  })

  test("all fail: error toast, no reload / focus", async () => {
    const adopt = [{ worktreePath: "/wt/x", branch: "x" }]
    const { ctx, notifyError, reload, selectTask, enterTask } = makeCreateCtx({
      adopt,
      adoptWorktree: async () => {
        throw new Error("nope")
      },
    })

    await createTaskFlow(ctx)

    expect(notifyError).toHaveBeenCalledTimes(1)
    expect(String(notifyError.mock.calls[0]?.[0])).toMatch(/nope/)
    expect(reload).not.toHaveBeenCalled()
    expect(selectTask).not.toHaveBeenCalled()
    expect(enterTask).not.toHaveBeenCalled()
  })
})

describe("createTaskFlow — create mode + guards", () => {
  test("create mode: calls task.create, remembers the vendor, saves the repo, lands on the new task", async () => {
    const promptNewTask = vi.fn(async () => ({
      mode: "create" as const,
      repo: "/repo",
      baseRef: "main",
      vendor: "claude",
    }))
    const { ctx, createTask, reload, selectTask, enterTask, rememberVendor } = makeCreateCtx({
      createTask: async () => ({ id: "new-id" }),
      promptNewTask,
    })

    await createTaskFlow(ctx)

    expect(createTask).toHaveBeenCalledWith({ repo: "/repo", baseRef: "main", vendor: "claude" })
    expect(rememberVendor).toHaveBeenCalledWith("/repo", "claude")
    expect(reload).toHaveBeenCalledTimes(1)
    expect(selectTask).toHaveBeenCalledWith("new-id")
    expect(enterTask).toHaveBeenCalledWith("new-id")
  })

  test("create mode failure surfaces a toast and skips reload/selection", async () => {
    const promptNewTask = vi.fn(async () => ({
      mode: "create" as const,
      repo: "/repo",
      baseRef: "main",
      vendor: "claude",
    }))
    const { ctx, notifyError, reload, selectTask } = makeCreateCtx({
      createTask: async () => {
        throw new Error("git worktree add failed")
      },
      promptNewTask,
    })

    await createTaskFlow(ctx)

    expect(notifyError).toHaveBeenCalledWith("Couldn't create task: git worktree add failed")
    expect(reload).not.toHaveBeenCalled()
    expect(selectTask).not.toHaveBeenCalled()
  })

  test("dialog cancelled (promptNewTask returns undefined) is a no-op", async () => {
    const promptNewTask = vi.fn(async () => undefined)
    const { ctx, reload, rememberVendor } = makeCreateCtx({ promptNewTask })

    await createTaskFlow(ctx)

    expect(rememberVendor).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  test("openCreateSurface handling it (returns true) short-circuits before the dialog", async () => {
    const openCreateSurface = vi.fn(async () => true)
    const promptNewTask = vi.fn(async () => ({
      mode: "create" as const,
      repo: "/repo",
      baseRef: "main",
      vendor: "claude",
    }))
    const { ctx } = makeCreateCtx({ openCreateSurface, promptNewTask })

    await createTaskFlow(ctx)

    expect(openCreateSurface).toHaveBeenCalledWith("/repo")
    expect(promptNewTask).not.toHaveBeenCalled()
  })

  test("no engine CLI detected surfaces an info notice but still proceeds", async () => {
    mockAvailableEngineIds.mockResolvedValueOnce([])
    const promptNewTask = vi.fn(async () => ({
      mode: "create" as const,
      repo: "/repo",
      baseRef: "main",
      vendor: "claude",
    }))
    const { ctx, notifyInfo, createTask } = makeCreateCtx({ promptNewTask })

    await createTaskFlow(ctx)

    expect(notifyInfo).toHaveBeenCalledWith(expect.stringContaining("No engine CLI detected"))
    expect(createTask).toHaveBeenCalled()
  })

  test("no daemon (orch null): saves the repo/vendor choice but logs instead of creating", async () => {
    const promptNewTask = vi.fn(async () => ({
      mode: "create" as const,
      repo: "/repo",
      baseRef: "main",
      vendor: "claude",
    }))
    const { ctx, rememberVendor, notifyInfo, reload, logger } = makeCreateCtx({ orch: null, promptNewTask })

    await createTaskFlow(ctx)

    expect(rememberVendor).toHaveBeenCalledWith("/repo", "claude")
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("no daemon"))
    expect(notifyInfo).not.toHaveBeenCalledWith(expect.stringContaining("Creating task"))
    expect(reload).not.toHaveBeenCalled()
  })
})
