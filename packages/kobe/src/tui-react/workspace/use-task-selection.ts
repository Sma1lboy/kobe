/**
 * Pure-TUI task selection + activation. Kept outside WorkspaceRoot so the
 * create-before-snapshot path is testable without mounting the full PTY host.
 */

import type { Task } from "../../types/task.ts"

type ActivateWorkspaceTaskOptions = {
  getTask: (id: string) => Task | undefined
  ensureWorktree: (id: string) => Promise<string>
  selectTask: (id: string) => void
  focusWorkspace: () => void
  reportError: (error: unknown) => void
}

export async function activateWorkspaceTask(opts: ActivateWorkspaceTaskOptions, id: string): Promise<boolean> {
  const task = opts.getTask(id)
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
  opts.selectTask(id)
  opts.focusWorkspace()
  return true
}

export function firstSelectableTask(tasks: readonly Task[], activeId: string | null): Task | undefined {
  const active = activeId ? tasks.find((task) => task.id === activeId && !task.archived) : undefined
  if (active) return active
  return tasks.find((task) => !task.archived) ?? tasks[0]
}
