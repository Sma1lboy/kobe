/**
 * Rename/branch/vendor flows from `src/tui/lib/task-actions.ts` — split out
 * of task-actions.test.ts (delete/archive flows) to keep both files under the
 * ~500-line cap. Same harness shape: modal UI arrives as context adapters, so
 * the flows run with plain mocks; engine detection is
 * module-mocked (every export the flows touch is stubbed).
 */

import { describe, expect, test, vi } from "vitest"

// cycleVendorFlow calls availableEngineIds() — the real one probes PATH
// binaries + reads state.json. Stub for hermeticity.
vi.mock("../../src/engine/account-detect", () => ({
  availableEngineIds: vi.fn(async () => ["claude", "codex"]),
}))

import type { KobeOrchestrator } from "../../src/client/remote-orchestrator"
import {
  type TaskActionContext,
  cycleVendorFlow,
  renameBranchFlow,
  renameTaskFlow,
} from "../../src/tui/lib/task-actions"
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
  setTitle: ReturnType<typeof vi.fn>
  setBranch: ReturnType<typeof vi.fn>
  setVendor: ReturnType<typeof vi.fn>
}

function makeOrch(overrides: Partial<OrchMock> = {}): OrchMock {
  return {
    setTitle: vi.fn(async () => {}),
    setBranch: vi.fn(async () => {}),
    setVendor: vi.fn(async () => {}),
    ...overrides,
  }
}

function makeCtx(opts: { tasks: readonly Task[]; orch: OrchMock | null; promptTextResult?: string | undefined }): {
  ctx: TaskActionContext
  promptText: ReturnType<typeof vi.fn>
  notifyError: ReturnType<typeof vi.fn>
  notifyInfo: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
} {
  const promptText = vi.fn(async () => opts.promptTextResult)
  const notifyError = vi.fn()
  const notifyInfo = vi.fn()
  const reload = vi.fn(async () => {})
  const ctx: TaskActionContext = {
    orch: opts.orch as unknown as KobeOrchestrator | null,
    tasks: () => opts.tasks,
    confirm: async () => true,
    promptText,
    logger: { error: vi.fn() },
    logPrefix: "[test]",
    notifyError,
    notifyInfo,
    reload,
  }
  return { ctx, promptText, notifyError, notifyInfo, reload }
}

describe("renameTaskFlow", () => {
  test("renames the task title and reloads", async () => {
    const tasks = [makeTask({ id: "t1", title: "old title" })]
    const orch = makeOrch()
    const { ctx, promptText, reload } = makeCtx({ tasks, orch, promptTextResult: "new title" })

    await renameTaskFlow(ctx, "t1")

    expect(promptText).toHaveBeenCalledWith("old title")
    expect(orch.setTitle).toHaveBeenCalledWith("t1", "new title")
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test("cancelled prompt (empty result) skips the RPC", async () => {
    const tasks = [makeTask({ id: "t1" })]
    const orch = makeOrch()
    const { ctx, reload } = makeCtx({ tasks, orch, promptTextResult: undefined })

    await renameTaskFlow(ctx, "t1")

    expect(orch.setTitle).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  test("RPC failure surfaces a toast and skips reload", async () => {
    const tasks = [makeTask({ id: "t1" })]
    const orch = makeOrch({
      setTitle: vi.fn(async () => {
        throw new Error("boom")
      }),
    })
    const { ctx, notifyError, reload } = makeCtx({ tasks, orch, promptTextResult: "new title" })

    await renameTaskFlow(ctx, "t1")

    expect(notifyError).toHaveBeenCalledWith("Couldn't rename task: boom")
    expect(reload).not.toHaveBeenCalled()
  })

  test("unknown taskId is a no-op", async () => {
    const tasks = [makeTask({ id: "t1" })]
    const orch = makeOrch()
    const { ctx, reload } = makeCtx({ tasks, orch, promptTextResult: "x" })

    await renameTaskFlow(ctx, "nope")

    expect(orch.setTitle).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })
})

describe("renameBranchFlow", () => {
  test("renames the branch and reloads", async () => {
    const tasks = [makeTask({ id: "t1", branch: "kobe/t1" })]
    const orch = makeOrch()
    const { ctx, promptText, reload } = makeCtx({ tasks, orch, promptTextResult: "feature/foo" })

    await renameBranchFlow(ctx, "t1")

    expect(promptText).toHaveBeenCalledWith("kobe/t1", { dialogTitle: "Rename branch", fieldLabel: "branch" })
    expect(orch.setBranch).toHaveBeenCalledWith("t1", "feature/foo")
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test("a `main` (project) row is a no-op — its branch isn't kobe's to rename", async () => {
    const tasks = [makeTask({ id: "m1", kind: "main" })]
    const orch = makeOrch()
    const { ctx, promptText } = makeCtx({ tasks, orch, promptTextResult: "x" })

    await renameBranchFlow(ctx, "m1")

    expect(promptText).not.toHaveBeenCalled()
    expect(orch.setBranch).not.toHaveBeenCalled()
  })

  test("cancelled prompt skips the RPC", async () => {
    const tasks = [makeTask({ id: "t1" })]
    const orch = makeOrch()
    const { ctx, reload } = makeCtx({ tasks, orch, promptTextResult: undefined })

    await renameBranchFlow(ctx, "t1")

    expect(orch.setBranch).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  test("RPC failure surfaces a toast and skips reload", async () => {
    const tasks = [makeTask({ id: "t1" })]
    const orch = makeOrch({
      setBranch: vi.fn(async () => {
        throw new Error("bad branch name")
      }),
    })
    const { ctx, notifyError, reload } = makeCtx({ tasks, orch, promptTextResult: "bad name" })

    await renameBranchFlow(ctx, "t1")

    expect(notifyError).toHaveBeenCalledWith("Couldn't rename branch: bad branch name")
    expect(reload).not.toHaveBeenCalled()
  })
})

describe("cycleVendorFlow", () => {
  test("cycles to the next vendor within the detected set, notifies, and reloads", async () => {
    const tasks = [makeTask({ id: "t1", vendor: "claude" as Task["vendor"] })]
    const orch = makeOrch()
    const { ctx, notifyInfo, reload } = makeCtx({ tasks, orch })

    await cycleVendorFlow(ctx, "t1")

    // account-detect is mocked to ["claude", "codex"] — cycling from claude
    // lands on codex.
    expect(orch.setVendor).toHaveBeenCalledWith("t1", "codex")
    expect(notifyInfo).toHaveBeenCalledWith(expect.stringContaining("applies on reopen"))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  test("RPC failure surfaces a toast and skips the deferred-rebuild notice + reload", async () => {
    const tasks = [makeTask({ id: "t1", vendor: "claude" as Task["vendor"] })]
    const orch = makeOrch({
      setVendor: vi.fn(async () => {
        throw new Error("nope")
      }),
    })
    const { ctx, notifyError, notifyInfo, reload } = makeCtx({ tasks, orch })

    await cycleVendorFlow(ctx, "t1")

    expect(notifyError).toHaveBeenCalledWith("Couldn't switch engine: nope")
    expect(notifyInfo).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  test("unknown taskId is a no-op", async () => {
    const tasks = [makeTask({ id: "t1" })]
    const orch = makeOrch()
    const { ctx } = makeCtx({ tasks, orch })

    await cycleVendorFlow(ctx, "nope")

    expect(orch.setVendor).not.toHaveBeenCalled()
  })

  test("no daemon (orch null) is a no-op", async () => {
    const tasks = [makeTask({ id: "t1" })]
    const { ctx } = makeCtx({ tasks, orch: null })

    await cycleVendorFlow(ctx, "t1")
  })
})
