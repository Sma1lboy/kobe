/**
 * Regression pin: `n` receives the created task id from the RPC before the
 * daemon snapshot necessarily causes a React render. Activation must not wait
 * for a second Enter just because the task is absent from the current snapshot.
 */

import { describe, expect, test, vi } from "vitest"
import { activateWorkspaceTask, firstSelectableTask } from "../../src/tui-react/workspace/use-task-selection"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"

function task(id: string, worktreePath: string): Task {
  return {
    id: toTaskId(id),
    title: id,
    repo: "/repo",
    branch: "main",
    worktreePath,
    kind: "task",
    status: "backlog",
    archived: false,
    pinned: false,
    vendor: "claude",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

describe("pure-TUI workspace task activation", () => {
  test("materializes and focuses a newly created task before its snapshot renders", async () => {
    const ensureWorktree = vi.fn(async () => "/worktrees/new-task")
    const selectTask = vi.fn()
    const focusWorkspace = vi.fn()

    const activated = await activateWorkspaceTask(
      {
        getTask: () => undefined,
        ensureWorktree,
        selectTask,
        focusWorkspace,
        reportError: vi.fn(),
      },
      "new-task",
    )

    expect(activated).toBe(true)
    expect(ensureWorktree).toHaveBeenCalledWith("new-task")
    expect(selectTask).toHaveBeenCalledWith("new-task")
    expect(focusWorkspace).toHaveBeenCalledOnce()
  })

  test("does not change selection when worktree materialization fails", async () => {
    const error = new Error("git worktree add failed")
    const reportError = vi.fn()
    const selectTask = vi.fn()
    const focusWorkspace = vi.fn()

    const activated = await activateWorkspaceTask(
      {
        getTask: () => undefined,
        ensureWorktree: vi.fn(async () => {
          throw error
        }),
        selectTask,
        focusWorkspace,
        reportError,
      },
      "new-task",
    )

    expect(activated).toBe(false)
    expect(reportError).toHaveBeenCalledWith(error)
    expect(selectTask).not.toHaveBeenCalled()
    expect(focusWorkspace).not.toHaveBeenCalled()
  })

  test("keeps the local fast path for an already materialized task", async () => {
    const ensureWorktree = vi.fn(async () => "/worktrees/existing")
    const selectTask = vi.fn()
    const focusWorkspace = vi.fn()
    const existing = task("existing", "/worktrees/existing")

    const activated = await activateWorkspaceTask(
      {
        getTask: () => existing,
        ensureWorktree,
        selectTask,
        focusWorkspace,
        reportError: vi.fn(),
      },
      "existing",
    )

    expect(activated).toBe(true)
    expect(ensureWorktree).not.toHaveBeenCalled()
    expect(selectTask).toHaveBeenCalledWith("existing")
    expect(focusWorkspace).toHaveBeenCalledOnce()
  })

  test("selection restore prefers a live active task, then the first non-archived row", () => {
    const active = task("active", "/worktrees/active")
    const archived = { ...task("archived", "/worktrees/archived"), archived: true }
    const fallback = task("fallback", "/worktrees/fallback")

    expect(firstSelectableTask([archived, active, fallback], "active")).toBe(active)
    expect(firstSelectableTask([archived, fallback], "missing")).toBe(fallback)
    expect(firstSelectableTask([archived], null)).toBe(archived)
    expect(firstSelectableTask([], null)).toBeUndefined()
  })
})
