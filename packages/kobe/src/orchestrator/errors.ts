import type { TaskStatus } from "../types/task.ts"

/** Maximum simultaneous `in_progress` tasks. From DESIGN §11.5. */
export const CONCURRENCY_CAP = 20

/** Thrown when a state-machine transition is illegal. */
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

/** Thrown when we'd exceed {@link CONCURRENCY_CAP}. */
export class ConcurrencyCapError extends Error {
  constructor() {
    super(`concurrency cap reached: ${CONCURRENCY_CAP} tasks running`)
    this.name = "ConcurrencyCapError"
  }
}

/** Thrown when a task id cannot be resolved. */
export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`task not found: ${taskId}`)
    this.name = "TaskNotFoundError"
  }
}

/**
 * Thrown when a caller tries to delete a task with `kind: "main"`.
 * Main tasks are bound to a saved repo entry, not a kobe-allocated worktree.
 */
export class CannotDeleteMainTaskError extends Error {
  constructor() {
    super("cannot delete a main task; remove the repo from saved repos instead")
    this.name = "CannotDeleteMainTaskError"
  }
}

/**
 * Stable sentinel embedded in {@link DirtyWorktreeError}'s message.
 *
 * The daemon RPC layer reconstructs a thrown error as `new Error(message)`
 * (the `name` field does NOT survive the wire), so a caller across the
 * daemon boundary can only discriminate on the MESSAGE. This code is that
 * machine-stable marker — match it with `err.message.includes(...)`.
 */
export const DIRTY_WORKTREE_CODE = "DIRTY_WORKTREE"

/**
 * Thrown when deleting a task whose worktree has uncommitted / untracked
 * changes and `force` was not requested. The UI catches it (via
 * {@link DIRTY_WORKTREE_CODE}) and re-prompts for explicit force-delete
 * confirmation rather than silently destroying the work (KOB-244).
 */
export class DirtyWorktreeError extends Error {
  constructor(public readonly taskId: string) {
    super(`${DIRTY_WORKTREE_CODE}: task ${taskId} worktree has uncommitted or untracked changes`)
    this.name = "DirtyWorktreeError"
  }
}

/**
 * Thrown when `git worktree remove` itself failed (locked, permission,
 * corrupt git-dir). The orchestrator keeps the task index entry in this
 * case so the orphaned worktree stays visible + re-deletable instead of
 * becoming invisible on-disk debris (KOB-244).
 */
export class WorktreeRemoveFailedError extends Error {
  constructor(
    public readonly taskId: string,
    public override readonly cause: unknown,
  ) {
    super(`failed to remove worktree for task ${taskId}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = "WorktreeRemoveFailedError"
  }
}
