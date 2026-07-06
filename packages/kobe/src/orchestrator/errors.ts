import type { TaskStatus } from "../types/task.ts"

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
    public readonly taskId: string,
  ) {
    super(`illegal transition for task ${taskId}: ${from} -> ${to}`)
    this.name = "IllegalTransitionError"
  }
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`task not found: ${taskId}`)
    this.name = "TaskNotFoundError"
  }
}

export class CannotDeleteMainTaskError extends Error {
  constructor() {
    super("cannot delete a main task; remove the repo from saved repos instead")
    this.name = "CannotDeleteMainTaskError"
  }
}

export const DIRTY_WORKTREE_CODE = "DIRTY_WORKTREE"

export class DirtyWorktreeError extends Error {
  constructor(public readonly taskId: string) {
    super(`${DIRTY_WORKTREE_CODE}: task ${taskId} worktree has uncommitted or untracked changes`)
    this.name = "DirtyWorktreeError"
  }
}

export class WorktreeRemoveFailedError extends Error {
  constructor(
    public readonly taskId: string,
    public override readonly cause: unknown,
  ) {
    super(`failed to remove worktree for task ${taskId}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = "WorktreeRemoveFailedError"
  }
}
