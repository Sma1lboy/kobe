/**
 * `createTaskFlow` adopt-mode summary (stability fix C).
 *
 * Adopting several worktrees is a loop of independent `adoptWorktree` calls.
 * The old code wrapped the loop in one try/catch: if item 2 failed, item 1 was
 * already persisted but the user only saw a generic "couldn't create task" and
 * the flow returned before reloading — the succeeded task was invisible. These
 * tests pin the per-item accounting + the real N/M summary that replaced it.
 *
 * The module deliberately has no `@opentui` imports, so the flow runs under
 * plain vitest with mocks. We stub the disk/CLI seams (`tmux`, saved-repo
 * state, engine detection) so the test is hermetic.
 */

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
  availableEngineIds: vi.fn(async () => ["claude"]),
}))

import type { KobeOrchestrator } from "../../src/client/remote-orchestrator"
import { type CreateTaskContext, createTaskFlow } from "../../src/tui/lib/task-actions"

type AdoptItem = { worktreePath: string; branch: string }

function makeCreateCtx(opts: {
  adopt: readonly AdoptItem[]
  adoptWorktree: (input: { worktreePath: string }) => Promise<{ id: string }>
}): {
  ctx: CreateTaskContext
  notifyInfo: ReturnType<typeof vi.fn>
  notifyError: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  selectTask: ReturnType<typeof vi.fn>
  enterTask: ReturnType<typeof vi.fn>
  adoptWorktree: ReturnType<typeof vi.fn>
} {
  const notifyInfo = vi.fn()
  const notifyError = vi.fn()
  const reload = vi.fn(async () => {})
  const selectTask = vi.fn()
  const enterTask = vi.fn(async () => {})
  const adoptWorktree = vi.fn(opts.adoptWorktree)
  const orch = {
    adoptWorktree,
    createTask: vi.fn(),
    discoverAdoptableWorktrees: vi.fn(async () => []),
  } as unknown as KobeOrchestrator
  const ctx: CreateTaskContext = {
    orch,
    tasks: () => [],
    confirm: async () => true,
    promptText: async () => undefined,
    logger: { error: vi.fn() },
    logPrefix: "[test]",
    notifyInfo,
    notifyError,
    reload,
    selectTask,
    enterTask,
    cursorRepo: () => "/repo",
    lastVendor: () => "claude" as never,
    rememberVendor: vi.fn(),
    promptNewTask: async () => ({ mode: "adopt", repo: "/repo", vendor: "claude" as never, adopt: opts.adopt }),
  }
  return { ctx, notifyInfo, notifyError, reload, selectTask, enterTask, adoptWorktree }
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
    // Reloaded + landed on the LAST success.
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

    // No fatal error toast — a partial success is surfaced as info, not a
    // dead-end "couldn't create".
    expect(notifyError).not.toHaveBeenCalled()
    const summary = notifyInfo.mock.calls.map((c) => String(c[0]))
    expect(summary.some((m) => /1\/2/.test(m))).toBe(true)
    // The flow still reloaded + focused the task that DID persist.
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
