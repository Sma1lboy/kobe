import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { DirtyWorktreeError, TaskDeletingError, WorktreeRemoveFailedError } from "../../src/orchestrator/errors.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import type { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"

let home: string
let store: TaskIndexStore
let orch: Orchestrator
let worktrees: {
  isDirty: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kobe-task-deletion-"))
  store = new TaskIndexStore({ homeDir: home })
  await store.load()
  worktrees = {
    isDirty: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
  }
  orch = new Orchestrator({ store, worktrees: worktrees as unknown as GitWorktreeManager })
})

afterEach(async () => {
  orch.dispose()
  await rm(home, { recursive: true, force: true })
})

async function makeTask(worktreePath = "/wt/task") {
  const task = await orch.createTask({ repo: "/repo", title: "task", vendor: "claude" })
  await store.update(task.id, { worktreePath })
  return orch.getTask(task.id)!
}

describe("durable background task deletion", () => {
  it("persists queued/running before physical cleanup and removes the task only on success", async () => {
    const task = await makeTask()

    await expect(orch.prepareTaskDeletion(task.id)).resolves.toBe(true)
    expect(orch.getTask(task.id)?.deletion).toMatchObject({ phase: "queued", force: false })
    expect(worktrees.remove).not.toHaveBeenCalled()

    await expect(orch.beginTaskDeletion(task.id)).resolves.toBe(true)
    expect(orch.getTask(task.id)?.deletion?.phase).toBe("running")

    await orch.finishTaskDeletion(task.id)
    expect(worktrees.remove).toHaveBeenCalledWith("/wt/task", { force: false, deleteBranch: true })
    expect(orch.getTask(task.id)).toBeUndefined()
  })

  it("keeps a visible error after cleanup failure and supports an explicit retry", async () => {
    const task = await makeTask()
    worktrees.remove.mockRejectedValueOnce(new Error("locked"))

    await orch.prepareTaskDeletion(task.id, { force: true })
    await orch.beginTaskDeletion(task.id)
    await expect(orch.finishTaskDeletion(task.id)).rejects.toThrow(WorktreeRemoveFailedError)
    expect(orch.getTask(task.id)?.deletion).toMatchObject({
      phase: "error",
      force: true,
      error: expect.stringContaining("locked"),
    })

    await orch.prepareTaskDeletion(task.id, { force: true })
    expect(orch.getTask(task.id)?.deletion).toMatchObject({ phase: "queued", force: true })
    await orch.beginTaskDeletion(task.id)
    await orch.finishTaskDeletion(task.id)
    expect(orch.getTask(task.id)).toBeUndefined()
  })

  it("runs the dirty-worktree guard before accepting and force bypasses it", async () => {
    const task = await makeTask("/wt/dirty")
    worktrees.isDirty.mockResolvedValue(true)

    await expect(orch.prepareTaskDeletion(task.id)).rejects.toThrow(DirtyWorktreeError)
    expect(orch.getTask(task.id)?.deletion).toBeUndefined()
    await expect(orch.prepareTaskDeletion(task.id, { force: true })).resolves.toBe(true)
    expect(worktrees.isDirty).toHaveBeenCalledTimes(1)
    expect(orch.getTask(task.id)?.deletion?.force).toBe(true)
  })

  it("rejects focus and worktree materialization once deletion is accepted", async () => {
    const task = await makeTask("")
    await orch.prepareTaskDeletion(task.id)

    await expect(orch.setActiveTask(task.id)).rejects.toThrow(TaskDeletingError)
    await expect(orch.ensureWorktree(task.id)).rejects.toThrow(TaskDeletingError)
  })
})
