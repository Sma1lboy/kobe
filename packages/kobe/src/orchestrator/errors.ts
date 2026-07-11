import { errorMessage } from "@/lib/error-message"
import type { TaskStatus } from "../types/task.ts"

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
 * confirmation rather than silently destroying the work.
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
 * becoming invisible on-disk debris.
 */
export class WorktreeRemoveFailedError extends Error {
  constructor(
    public readonly taskId: string,
    public override readonly cause: unknown,
  ) {
    super(`failed to remove worktree for task ${taskId}: ${errorMessage(cause)}`)
    this.name = "WorktreeRemoveFailedError"
  }
}

/**
 * Stable sentinel embedded in {@link MainCheckoutDirtyError}'s message — the
 * `name` field doesn't survive the daemon wire, so a caller across the boundary
 * discriminates on the MESSAGE (`err.message.includes(MAIN_CHECKOUT_DIRTY_CODE)`).
 */
export const MAIN_CHECKOUT_DIRTY_CODE = "MAIN_CHECKOUT_DIRTY"

/**
 * Thrown by `landTask` when the base repo's checkout has uncommitted changes.
 * Landing merges the task branch INTO that checkout, so a dirty tree would
 * entangle the user's in-progress work with the landed branch — we refuse and
 * let them commit/stash first.
 */
export class MainCheckoutDirtyError extends Error {
  constructor(
    public readonly repo: string,
    public readonly dir: string,
  ) {
    super(
      `${MAIN_CHECKOUT_DIRTY_CODE}: base checkout at ${dir} has uncommitted changes; commit or stash them before landing`,
    )
    this.name = "MainCheckoutDirtyError"
  }
}

/**
 * Stable sentinel embedded in {@link LandConflictError}'s message — same
 * wire-boundary reason as {@link DIRTY_WORKTREE_CODE}. The conflicted-file list
 * rides along in the message so a CLI/TUI caller can print it after matching.
 */
export const LAND_CONFLICT_CODE = "LAND_CONFLICT"

/**
 * Thrown by `landTask` when the merge hit conflicts. The merge is aborted
 * before this throws, so the base checkout is left exactly as it was; the
 * conflicted paths are carried so the caller can show the human what to resolve.
 */
export class LandConflictError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly branch: string,
    public readonly files: readonly string[],
  ) {
    const list = files.length > 0 ? files.join(", ") : "(none reported)"
    super(`${LAND_CONFLICT_CODE}: merging '${branch}' hit conflicts, merge aborted — conflicted files: ${list}`)
    this.name = "LandConflictError"
  }
}
