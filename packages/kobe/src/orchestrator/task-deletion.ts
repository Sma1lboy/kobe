import { errorMessage } from "../lib/error-message.ts"
import type { TaskId } from "../types/task.ts"
import { CannotDeleteMainTaskError, DirtyWorktreeError, WorktreeRemoveFailedError } from "./errors.ts"
import type { TaskIndexStore } from "./index/store.ts"
import type { GitWorktreeManager } from "./worktree/manager.ts"

/**
 * Persistent task-deletion state machine. The daemon owns scheduling; this
 * collaborator owns safety checks and the atomic task-index transitions.
 */
export class TaskDeletionCoordinator {
  constructor(
    private readonly store: TaskIndexStore,
    private readonly worktrees: GitWorktreeManager,
    private readonly forgetTask: (id: TaskId) => void,
  ) {}

  /** Persist acceptance after the destructive dirty-worktree safety check. */
  async prepare(id: TaskId | string, opts?: { readonly force?: boolean }): Promise<boolean> {
    const task = this.store.get(id)
    if (!task) return false
    if (task.kind === "main") throw new CannotDeleteMainTaskError()
    if (task.deletion?.phase === "queued" || task.deletion?.phase === "running") return true

    const force = opts?.force === true
    if (task.worktreePath && !force) {
      let dirty = false
      try {
        dirty = await this.worktrees.isDirty(task.worktreePath)
      } catch {
        // A missing/unreadable path is resolved by remove(), as before.
      }
      if (dirty) throw new DirtyWorktreeError(task.id)
    }

    await this.store.update(task.id, {
      deletion: {
        phase: "queued",
        force,
        requestedAt: new Date().toISOString(),
      },
    })
    return true
  }

  /** Mark a queued/resumed deletion as actively owned by a daemon runner. */
  async begin(id: TaskId | string): Promise<boolean> {
    const task = this.store.get(id)
    if (!task || !task.deletion || task.deletion.phase === "error") return false
    if (task.deletion.phase !== "running") {
      await this.store.update(task.id, { deletion: { ...task.deletion, phase: "running" } })
    }
    return true
  }

  /** Remove the worktree and task entry; retain a durable error on failure. */
  async finish(id: TaskId | string): Promise<void> {
    const task = this.store.get(id)
    if (!task?.deletion || task.deletion.phase !== "running") return
    try {
      if (task.worktreePath) {
        await this.worktrees.remove(task.worktreePath, {
          force: task.deletion.force,
          deleteBranch: true,
        })
      }
    } catch (cause) {
      const failure = new WorktreeRemoveFailedError(task.id, cause)
      await this.store.update(task.id, {
        deletion: {
          ...task.deletion,
          phase: "error",
          error: errorMessage(failure),
        },
      })
      throw failure
    }
    await this.store.remove(task.id)
    this.forgetTask(task.id)
  }

  /** Compatibility path for local callers that still require completion. */
  async deleteNow(id: TaskId | string, opts?: { readonly force?: boolean }): Promise<void> {
    if (!(await this.prepare(id, opts))) return
    if (!(await this.begin(id))) return
    await this.finish(id)
  }
}
