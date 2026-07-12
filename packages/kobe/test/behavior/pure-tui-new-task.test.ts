/**
 * Regression: PureTUI `n` creation must materialize the new worktree
 * without a second Enter. This composes the shared create flow with the
 * pure-TUI activation boundary while its React task snapshot is still empty.
 */

import { describe, expect, test, vi } from "vitest"

vi.mock("../../src/state/repos", () => ({
  getSavedRepos: () => ["/repo"],
  addSavedRepo: vi.fn(() => ({ added: false, path: "/repo", total: 1 })),
}))
vi.mock("../../src/engine/account-detect", () => ({
  availableEngineIds: vi.fn(async () => ["claude"]),
}))
import type { KobeOrchestrator } from "../../src/client/remote-orchestrator"
import { activateWorkspaceTask } from "../../src/tui-react/workspace/use-task-selection"
import { type CreateTaskContext, createTaskFlow } from "../../src/tui/lib/task-create-flow"

describe("pure-TUI new-task auto-materialization (behavior)", () => {
  test("one dialog submit creates, materializes, selects, and focuses the task before snapshot render", async () => {
    const ensureWorktree = vi.fn(async () => "/worktrees/new-task")
    const selectTask = vi.fn()
    const focusWorkspace = vi.fn()
    const orch = {
      createTask: vi.fn(async () => ({ id: "new-task" })),
      discoverAdoptableWorktrees: vi.fn(async () => []),
    } as unknown as KobeOrchestrator
    const ctx: CreateTaskContext = {
      orch,
      tasks: () => [],
      confirm: async () => true,
      promptText: async () => undefined,
      promptNewTask: async () => ({ mode: "create", repo: "/repo", baseRef: "main", vendor: "claude" }),
      cursorRepo: () => "/repo",
      lastVendor: () => "claude",
      rememberVendor: vi.fn(),
      logger: console,
      logPrefix: "[behavior]",
      selectTask,
      enterTask: (id) =>
        activateWorkspaceTask(
          {
            // The daemon snapshot has not triggered the next React render.
            getTask: () => undefined,
            ensureWorktree,
            selectTask,
            focusWorkspace,
            reportError: vi.fn(),
          },
          id,
        ).then(() => {}),
    }

    await createTaskFlow(ctx)

    expect(orch.createTask).toHaveBeenCalledOnce()
    expect(ensureWorktree).toHaveBeenCalledWith("new-task")
    expect(selectTask).toHaveBeenCalledWith("new-task")
    expect(focusWorkspace).toHaveBeenCalledOnce()
  })
})
