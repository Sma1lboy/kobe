import type { KobeOrchestrator } from "@/client/remote-orchestrator"
import { availableEngineIds } from "@/engine/account-detect"
import { engineDisplayName } from "@/engine/interactive-command"
import { DIRTY_WORKTREE_CODE } from "@/orchestrator/errors"
import { addSavedRepo, getSavedRepos } from "@/state/repos"
import { t } from "@/tui/i18n"
import { DEFAULT_TASK_VENDOR, type Task, type VendorId } from "@/types/task"
import { nextVendorWithin } from "@/types/vendor"
import type { NewTaskDialogOptions, NewTaskInput } from "../component/new-task-dialog"
import { killSession, switchClientBeforeKill, tmuxSessionName } from "../panes/terminal/tmux"

export interface TaskActionLogger {
  error(message?: unknown, ...optionalParams: unknown[]): void
}

export interface ConfirmPrompt {
  readonly title: string
  readonly body: string
  readonly cancelLabel: string
  readonly confirmLabel: string
}

export interface TextPromptOpts {
  readonly dialogTitle?: string
  readonly fieldLabel?: string
}

export interface TaskActionContext {
  readonly orch: KobeOrchestrator | null
  readonly tasks: () => readonly Task[]
  readonly confirm: (prompt: ConfirmPrompt) => Promise<boolean>
  readonly promptText: (initial: string, opts?: TextPromptOpts) => Promise<string | undefined>
  readonly logger: TaskActionLogger
  readonly logPrefix: string
  readonly notifyError?: (message: string) => void
  readonly notifyInfo?: (message: string) => void
  readonly reload?: () => Promise<void>
  readonly switchBeforeKill?: boolean
  readonly updateActiveTask?: boolean
  readonly onTaskDeleted?: (taskId: string, nextTask: Task | undefined) => void
}

export interface CreateTaskContext extends TaskActionContext {
  readonly promptNewTask: (
    defaultRepo: string,
    repos: readonly string[],
    opts: NewTaskDialogOptions,
  ) => Promise<NewTaskInput | undefined>
  readonly cursorRepo: () => string | undefined
  readonly lastVendor: (repo: string) => VendorId | undefined
  readonly rememberVendor: (repo: string, vendor: VendorId) => void
  readonly onRepoSaved?: () => void
  readonly openCreateSurface?: (defaultRepo: string) => Promise<boolean>
  readonly selectTask?: (id: string) => void
  readonly enterTask?: (id: string) => void | Promise<void>
}

export function nextActiveTask(tasks: readonly Task[], excludeId: string): Task | undefined {
  return tasks.find((t) => t.id !== excludeId && !t.archived)
}

function removedTaskIsActive(orch: KobeOrchestrator, taskId: string): boolean {
  const read = (orch as { activeTaskSignal?: () => () => string | null }).activeTaskSignal
  if (typeof read !== "function") return true
  return read.call(orch)() === taskId
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
  if (opts.updateActiveTask && removedTaskIsActive(opts.orch, opts.taskId)) {
    await opts.orch.setActiveTask(nextTask?.id ?? null).catch(() => {})
  }
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
  if (opts.updateActiveTask && opts.orch && removedTaskIsActive(opts.orch, opts.taskId)) {
    await opts.orch.setActiveTask(nextTask?.id ?? null).catch(() => {})
  }
  await killSession(sessionName).catch((err: unknown) => {
    opts.logger.error(`${opts.logPrefix} kill tmux session failed:`, err)
  })
  return { nextTask }
}

export async function archiveTaskFlow(ctx: TaskActionContext, taskId: string): Promise<void> {
  if (!ctx.orch) return
  const task = ctx.tasks().find((t) => t.id === taskId)
  if (!task) return
  if (!task.archived) {
    const ok = await ctx.confirm({
      title: `Archive "${task.title}"?`,
      body: "Moves it to Archives and stops its running session. The worktree, branch, and chat history stay — unarchive to bring it back.",
      cancelLabel: "cancel",
      confirmLabel: "archive",
    })
    if (!ok) return
  }
  const result = await toggleTaskArchivedFlow({
    orch: ctx.orch,
    tasks: ctx.tasks(),
    taskId,
    logger: ctx.logger,
    logPrefix: ctx.logPrefix,
    updateActiveTask: ctx.updateActiveTask,
  })
  if (!result) return
  await ctx.reload?.()
}

export async function deleteTaskFlow(ctx: TaskActionContext, taskId: string): Promise<void> {
  if (!ctx.orch) return
  const task = ctx.tasks().find((t) => t.id === taskId)
  if (!task) return
  if (task.kind === "main") {
    const ok = await ctx.confirm({
      title: `Remove project "${task.title}"?`,
      body: "Forgets it from the projects list. The repo, its branches, worktrees, and any tasks under it stay on disk — re-add it with `kobe add`.",
      cancelLabel: "cancel",
      confirmLabel: "remove",
    })
    if (!ok) return
    try {
      await ctx.orch.forgetProject(task.repo)
    } catch (err) {
      ctx.logger.error(`${ctx.logPrefix} forget project failed:`, err)
      ctx.notifyError?.(`Couldn't remove: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    await ctx.reload?.()
    return
  }
  const ok = await ctx.confirm({
    title: `Delete "${task.title}"?`,
    body: "Removes the task entry and its worktree. The tmux session (if any) is killed.",
    cancelLabel: "cancel",
    confirmLabel: "delete",
  })
  if (!ok) return
  let deleted = false
  try {
    await ctx.orch.deleteTask(taskId)
    deleted = true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes(DIRTY_WORKTREE_CODE)) {
      const forceOk = await ctx.confirm({
        title: `"${task.title}" has uncommitted changes`,
        body: "Its worktree has uncommitted or untracked work that will be permanently deleted. Force delete anyway?",
        cancelLabel: "cancel",
        confirmLabel: "force delete",
      })
      if (forceOk) {
        try {
          await ctx.orch.deleteTask(taskId, { force: true })
          deleted = true
        } catch (forceErr) {
          ctx.logger.error(`${ctx.logPrefix} force delete failed:`, forceErr)
          ctx.notifyError?.(`Couldn't delete: ${forceErr instanceof Error ? forceErr.message : String(forceErr)}`)
        }
      }
    } else {
      ctx.logger.error(`${ctx.logPrefix} delete failed:`, err)
      ctx.notifyError?.(`Couldn't delete: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!deleted) return
  const { nextTask } = await finishDeletedTaskFlow({
    orch: ctx.orch,
    tasks: ctx.tasks(),
    taskId,
    logger: ctx.logger,
    logPrefix: ctx.logPrefix,
    switchBeforeKill: ctx.switchBeforeKill,
    updateActiveTask: ctx.updateActiveTask,
  })
  await ctx.reload?.()
  ctx.onTaskDeleted?.(taskId, nextTask)
}

export async function renameTaskFlow(ctx: TaskActionContext, taskId: string): Promise<void> {
  const task = ctx.tasks().find((t) => t.id === taskId)
  if (!task) return
  const next = await ctx.promptText(task.title)
  if (!next || !ctx.orch) return
  try {
    await ctx.orch.setTitle(taskId, next)
  } catch (err) {
    ctx.logger.error(`${ctx.logPrefix} task.rename failed:`, err)
    ctx.notifyError?.(`Couldn't rename task: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  await ctx.reload?.()
}

export async function renameBranchFlow(ctx: TaskActionContext, taskId: string): Promise<void> {
  const task = ctx.tasks().find((t) => t.id === taskId)
  if (!task || task.kind === "main") return
  const next = await ctx.promptText(task.branch, { dialogTitle: "Rename branch", fieldLabel: "branch" })
  if (!next || !ctx.orch) return
  try {
    await ctx.orch.setBranch(taskId, next)
  } catch (err) {
    ctx.logger.error(`${ctx.logPrefix} task.setBranch failed:`, err)
    ctx.notifyError?.(`Couldn't rename branch: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  await ctx.reload?.()
}

export async function cycleVendorFlow(ctx: TaskActionContext, taskId: string): Promise<void> {
  const task = ctx.tasks().find((t) => t.id === taskId)
  if (!task || !ctx.orch) return
  const engines = await availableEngineIds()
  const next = nextVendorWithin(engines, task.vendor ?? DEFAULT_TASK_VENDOR)
  try {
    await ctx.orch.setVendor(taskId, next)
  } catch (err) {
    ctx.logger.error(`${ctx.logPrefix} task.setVendor failed:`, err)
    ctx.notifyError?.(`Couldn't switch engine: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  ctx.notifyInfo?.(`Engine → ${engineDisplayName(next)} (applies on reopen)`)
  await ctx.reload?.()
}

export async function createTaskFlow(ctx: CreateTaskContext): Promise<void> {
  const repos = getSavedRepos()
  const defaultRepo = ctx.cursorRepo() ?? repos[0] ?? process.cwd()
  if (ctx.openCreateSurface && (await ctx.openCreateSurface(defaultRepo))) return
  const defaultVendor = ctx.lastVendor(defaultRepo) ?? DEFAULT_TASK_VENDOR
  const availableVendors = await availableEngineIds()
  if (availableVendors.length === 0) {
    ctx.notifyInfo?.("No engine CLI detected — install claude or codex, or add one in Settings → Engines")
  }
  const orch = ctx.orch
  const result = await ctx.promptNewTask(defaultRepo, repos, {
    defaultVendor,
    availableVendors,
    discoverAdoptable: orch ? (repo) => orch.discoverAdoptableWorktrees(repo) : undefined,
  })
  if (!result) return
  ctx.rememberVendor(result.repo, result.vendor)
  addSavedRepo(result.repo)
  ctx.onRepoSaved?.()
  if (!orch) {
    ctx.logger.error(`${ctx.logPrefix} no daemon; cannot create task`)
    return
  }
  ctx.notifyInfo?.("Creating task…")
  let createdId: string | undefined
  if (result.mode === "adopt") {
    const total = result.adopt.length
    let adopted = 0
    let firstError: string | undefined
    for (const w of result.adopt) {
      try {
        const task = await orch.adoptWorktree({
          repo: result.repo,
          worktreePath: w.worktreePath,
          branch: w.branch,
          vendor: result.vendor,
        })
        createdId = task.id
        adopted++
      } catch (err) {
        if (firstError === undefined) firstError = err instanceof Error ? err.message : String(err)
        ctx.logger.error(`${ctx.logPrefix} adoptWorktree failed for ${w.worktreePath}:`, err)
      }
    }
    if (adopted === 0) {
      ctx.notifyError?.(t("newTask.adopt.summaryNone", { error: firstError ?? "" }))
      return
    }
    if (adopted < total) ctx.notifyInfo?.(t("newTask.adopt.summaryPartial", { done: adopted, total }))
    else ctx.notifyInfo?.(t("newTask.adopt.summaryAll", { count: adopted }))
  } else {
    try {
      const task = await orch.createTask({
        repo: result.repo,
        baseRef: result.baseRef,
        vendor: result.vendor,
      })
      createdId = task.id
    } catch (err) {
      ctx.logger.error(`${ctx.logPrefix} task.create failed:`, err)
      ctx.notifyError?.(`Couldn't create task: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
  }
  await ctx.reload?.()
  if (createdId) {
    ctx.selectTask?.(createdId)
    await ctx.enterTask?.(createdId)
  }
}
