import type { KobeOrchestrator } from "@/client/remote-orchestrator"
import type { Task } from "@/types/task"
import { killSession, switchClientBeforeKill, tmuxSessionName } from "../panes/terminal/tmux"

export interface TaskActionLogger {
  error(message?: unknown, ...optionalParams: unknown[]): void
}

export function nextActiveTask(tasks: readonly Task[], excludeId: string): Task | undefined {
  return tasks.find((t) => t.id !== excludeId && !t.archived)
}

export async function toggleTaskArchivedFlow(opts: {
  readonly orch: KobeOrchestrator
  readonly tasks: readonly Task[]
  readonly taskId: string
  readonly logger: TaskActionLogger
  readonly logPrefix: string
  readonly updateActiveTask?: boolean
}): Promise<{ archived: boolean; nextTask?: Task } | null> {
  const task = opts.tasks.find((t) => t.id === opts.taskId)
  if (!task) return null
  const archived = !task.archived
  try {
    await opts.orch.setArchived(opts.taskId, archived)
  } catch (err) {
    opts.logger.error(`${opts.logPrefix} archive failed:`, err)
    return null
  }
  if (!archived) return { archived }

  const sessionName = tmuxSessionName(opts.taskId)
  const nextTask = nextActiveTask(opts.tasks, opts.taskId)
  await switchClientBeforeKill(sessionName, nextTask ? tmuxSessionName(nextTask.id) : undefined).catch(
    (err: unknown) => {
      opts.logger.error(`${opts.logPrefix} switch-client failed:`, err)
    },
  )
  if (opts.updateActiveTask) await opts.orch.setActiveTask(nextTask?.id ?? null).catch(() => {})
  await killSession(sessionName).catch((err: unknown) => {
    opts.logger.error(`${opts.logPrefix} kill tmux session failed:`, err)
  })
  return { archived, nextTask }
}

export async function finishDeletedTaskFlow(opts: {
  readonly orch?: KobeOrchestrator
  readonly tasks: readonly Task[]
  readonly taskId: string
  readonly logger: TaskActionLogger
  readonly logPrefix: string
  readonly switchBeforeKill?: boolean
  readonly updateActiveTask?: boolean
}): Promise<{ nextTask?: Task }> {
  const nextTask = nextActiveTask(opts.tasks, opts.taskId)
  const sessionName = tmuxSessionName(opts.taskId)
  if (opts.switchBeforeKill) {
    await switchClientBeforeKill(sessionName, nextTask ? tmuxSessionName(nextTask.id) : undefined).catch(
      (err: unknown) => {
        opts.logger.error(`${opts.logPrefix} switch-client failed:`, err)
      },
    )
  }
  if (opts.updateActiveTask) await opts.orch?.setActiveTask(nextTask?.id ?? null).catch(() => {})
  await killSession(sessionName).catch((err: unknown) => {
    opts.logger.error(`${opts.logPrefix} kill tmux session failed:`, err)
  })
  return { nextTask }
}

export async function toggleTaskPinnedFlow(opts: {
  readonly orch: KobeOrchestrator
  readonly taskId: string
  readonly logger: TaskActionLogger
  readonly logPrefix: string
}): Promise<void> {
  await opts.orch.setPinned(opts.taskId).catch((err: unknown) => {
    opts.logger.error(`${opts.logPrefix} pin failed:`, err)
  })
}
