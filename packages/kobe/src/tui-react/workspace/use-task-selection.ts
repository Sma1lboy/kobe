/**
 * Pure-TUI task selection + activation. Kept outside WorkspaceRoot so the
 * create-before-snapshot path is testable without mounting the full PTY host.
 */

import { TaskDeletingError } from "../../orchestrator/errors.ts"
import type { Task } from "../../types/task.ts"

type ActivateWorkspaceTaskOptions = {
  getTask: (id: string) => Task | undefined
  ensureWorktree: (id: string) => Promise<string>
  selectTask: (id: string) => void
  focusWorkspace: () => void
  reportError: (error: unknown) => void
  /** Last-intent guard: `false` after the await means a newer activation
   *  superseded this one, so selection/focus must not be applied. */
  isCurrent?: () => boolean
}

export async function activateWorkspaceTask(opts: ActivateWorkspaceTaskOptions, id: string): Promise<boolean> {
  const task = opts.getTask(id)
  if (task?.deletion) {
    opts.reportError(new TaskDeletingError(id))
    return false
  }
  // A create RPC can resolve before the daemon's task snapshot causes the
  // workspace host to render. An unknown task is therefore not proof that the
  // id is invalid — materialize by the authoritative RPC id and let the daemon
  // reject a genuinely missing task. `ensureWorktree` is idempotent, so known
  // materialized tasks can keep the local fast path below.
  if (!task?.worktreePath) {
    try {
      await opts.ensureWorktree(id)
    } catch (error) {
      opts.reportError(error)
      return false
    }
  }
  if (opts.isCurrent?.() === false) return false
  opts.selectTask(id)
  opts.focusWorkspace()
  return true
}

/**
 * Boot/fallback selection, in trust order: the daemon's active task → the
 * persisted `lastActive` record (survives daemon confusion: a stale or
 * freshly-respawned daemon can replay a null/ancient focus while disk still
 * knows the truth) → the most recently UPDATED unarchived task. Raw array
 * order is never used as a tiebreak — tasks.json leads with the oldest
 * saved repo's main task, which is how every SSH reconnect used to land on
 * an untouched project instead of the one being worked on.
 */
export function firstSelectableTask(
  tasks: readonly Task[],
  activeId: string | null,
  lastActiveId?: string | null,
): Task | undefined {
  const alive = (id: string | null | undefined): Task | undefined =>
    id ? tasks.find((task) => task.id === id && !task.archived && !task.deletion) : undefined
  const active = alive(activeId) ?? alive(lastActiveId)
  if (active) return active
  const unarchived = tasks.filter((task) => !task.archived && !task.deletion)
  if (unarchived.length > 0)
    return unarchived.reduce((newest, task) => (task.updatedAt > newest.updatedAt ? task : newest))
  return tasks.find((task) => !task.deletion)
}
