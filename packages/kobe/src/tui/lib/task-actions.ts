/**
 * Shared task-action flows — the ONE implementation behind the hosts
 * that expose task mutations. Today that's the in-session Tasks pane
 * (`tui/tasks-pane/host.tsx`); the deprecated outer monitor (`app.tsx`)
 * was the second host until its retirement (docs/design/app-retirement.md)
 * — consolidating here is what made that a pure deletion, not a port.
 * Host differences (e.g. the Tasks pane lives INSIDE the tmux client it
 * may kill) are an explicit option or hook on {@link TaskActionContext},
 * never a second copy.
 *
 * Testability rule: NO `@opentui` imports here. Modal UI (DialogConfirm /
 * RenameTaskDialog / NewTaskDialog) reaches this module only as
 * context-provided adapter callbacks (`confirm`, `promptText`,
 * `promptNewTask`), so the flows run under plain vitest with mocks
 * (`test/tui/task-actions.test.ts`).
 */

import type { KobeOrchestrator } from "@/client/remote-orchestrator"
import { availableEngineIds } from "@/engine/account-detect"
import { engineDisplayName } from "@/engine/interactive-command"
import { DIRTY_WORKTREE_CODE } from "@/orchestrator/errors"
import { addSavedRepo, getSavedRepos } from "@/state/repos"
import { DEFAULT_TASK_VENDOR, type Task, type VendorId } from "@/types/task"
import { nextVendorWithin } from "@/types/vendor"
import type { NewTaskDialogOptions, NewTaskInput } from "../component/new-task-dialog"
import { killSession, switchClientBeforeKill, tmuxSessionName } from "../panes/terminal/tmux"

export interface TaskActionLogger {
  error(message?: unknown, ...optionalParams: unknown[]): void
}

/**
 * Confirm-modal copy for {@link TaskActionContext.confirm}. The COPY lives
 * in the flows (single source for both hosts); only the rendering is
 * host-provided — each host implements `confirm` with `DialogConfirm.show`.
 */
export interface ConfirmPrompt {
  readonly title: string
  readonly body: string
  readonly cancelLabel: string
  readonly confirmLabel: string
}

/** Optional labels for {@link TaskActionContext.promptText} (RenameTaskDialog reuses). */
export interface TextPromptOpts {
  readonly dialogTitle?: string
  readonly fieldLabel?: string
}

/**
 * Host-agnostic context bag the lifted flows run against. Required members
 * are what BOTH hosts provide; every optional member is a documented
 * host divergence — modeled here as an option/hook so neither host keeps
 * its own copy of a flow.
 */
export interface TaskActionContext {
  /**
   * Daemon-backed mutation surface. `null` only in the Tasks pane's
   * degraded no-daemon fallback, where mutations are unavailable — flows
   * no-op (or log, matching the pane's old behavior).
   */
  readonly orch: KobeOrchestrator | null
  /** Live task list accessor (orchestrator signal or file-poll fallback). */
  readonly tasks: () => readonly Task[]
  /** Confirm-modal adapter — host implements with `DialogConfirm.show(dialog, …) === true`. */
  readonly confirm: (prompt: ConfirmPrompt) => Promise<boolean>
  /** Text-input adapter — host implements with `RenameTaskDialog.show(dialog, …)`. */
  readonly promptText: (initial: string, opts?: TextPromptOpts) => Promise<string | undefined>
  readonly logger: TaskActionLogger
  /** Forensic log tag — `[kobe]` (outer monitor) vs `[kobe tasks]` (Tasks pane). */
  readonly logPrefix: string
  /**
   * DIVERGENCE — on-screen failure toast. The Tasks pane surfaces failures
   * as red toasts (under tmux's alternate screen a bare console.error is
   * invisible); the outer monitor has no toast wiring for task actions, so
   * it omits this and failures stay log-only, as before.
   */
  readonly notifyError?: (message: string) => void
  /** DIVERGENCE — neutral "this happened" toast. Same split as `notifyError`. */
  readonly notifyInfo?: (message: string) => void
  /**
   * DIVERGENCE — force an immediate tasks.json re-read after a mutation.
   * The Tasks pane needs it for its poll fallback; the outer monitor is
   * signal-driven and omits it.
   */
  readonly reload?: () => Promise<void>
  /**
   * DIVERGENCE — the Tasks pane runs INSIDE the tmux client whose session
   * a delete may kill, so it must `switch-client` away first or the kill
   * yanks the user's terminal out from under them. The outer monitor sits
   * outside tmux and omits this.
   */
  readonly switchBeforeKill?: boolean
  /**
   * DIVERGENCE — publish the shared active-task focus after archive/delete
   * (KOB-247). The Tasks pane sets this; the outer monitor historically
   * didn't and keeps that behavior.
   */
  readonly updateActiveTask?: boolean
  /**
   * DIVERGENCE — selection is host-owned signal state, so the post-delete
   * cursor move stays a hook: the Tasks pane prefers the flow-computed
   * `nextTask`, the outer monitor recomputes from the remaining list.
   */
  readonly onTaskDeleted?: (taskId: string, nextTask: Task | undefined) => void
}

/**
 * Extra hooks the create flow needs on top of {@link TaskActionContext}.
 * Hosts build ONE object satisfying this and pass it to every flow.
 */
export interface CreateTaskContext extends TaskActionContext {
  /** New-task dialog adapter — host implements with `NewTaskDialog.show(dialog, …)`. */
  readonly promptNewTask: (
    defaultRepo: string,
    repos: readonly string[],
    opts: NewTaskDialogOptions,
  ) => Promise<NewTaskInput | undefined>
  /**
   * DIVERGENCE — the "spawn a sibling" default repo: the outer monitor
   * uses the active task's repo; the Tasks pane uses the cursor row's
   * (falling back to the first listed task). The flow falls back to
   * `savedRepos[0]` then `process.cwd()` for both.
   */
  readonly cursorRepo: () => string | undefined
  /**
   * DIVERGENCE — last-selected-vendor persistence: the outer monitor
   * goes through its in-process kv store, the Tasks pane through the
   * disk-only `getPersistedString`/`setPersistedString` pair. Same
   * state.json underneath, different write paths.
   */
  readonly lastVendor: () => VendorId | undefined
  readonly rememberVendor: (vendor: VendorId) => void
  /**
   * DIVERGENCE — after `addSavedRepo`, the outer monitor mirrors the fresh
   * list into its kv store so the debounced whole-store flush doesn't
   * clobber the disk write. The Tasks pane is disk-only and omits this.
   */
  readonly onRepoSaved?: () => void
  /**
   * DIVERGENCE — the Tasks pane's chattab surface preference can route the
   * new-task flow to a dedicated tmux tab instead of the in-pane dialog.
   * Return `true` when handled elsewhere (flow stops). The outer monitor
   * has no tmux session to open a tab in and omits this.
   */
  readonly openCreateSurface?: (defaultRepo: string) => Promise<boolean>
  /** Land the host's cursor/selection on the created (or last adopted) task. */
  readonly selectTask?: (id: string) => void
  /**
   * Enter (switch into) the created (or last adopted) task right after
   * creation — so `n` drops the user in the engine pane ready to type the
   * first prompt, instead of just landing the cursor. The Tasks pane wires
   * this to its `switchTo`; the chattab surface does its own jump and never
   * reaches here.
   */
  readonly enterTask?: (id: string) => void | Promise<void>
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

  // Archiving STOPS the task's running engine: switch the client away, clear
  // active-task focus, then kill its tmux session so an archived task doesn't
  // keep a live engine subprocess burning resources/tokens. Non-destructive to
  // DATA — the worktree, branch, and chat history stay on disk and the session
  // is rebuilt fresh on unarchive / next enter. Gated behind a confirm at the
  // call site (it ends a running session). Mirrors finishDeletedTaskFlow's
  // teardown; the difference from delete is purely that the task record + its
  // worktree survive.
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

/**
 * Archive (or unarchive) a task. Unarchive is harmless — brings the task
 * back, no confirm. Archiving STOPS the task's running engine session, so
 * it confirms first, then runs the shared stop-and-kill teardown
 * ({@link toggleTaskArchivedFlow}).
 */
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

/**
 * Delete a task: confirm → non-force delete → on DIRTY_WORKTREE re-prompt
 * for an explicit force-delete → tear down the tmux session → host
 * selection hook. The first attempt is deliberately non-force: the
 * orchestrator refuses to destroy a worktree with uncommitted/untracked
 * work and throws a DIRTY_WORKTREE error instead, so the user can't lose
 * unsaved work silently (KOB-244). A failed/declined delete leaves
 * everything in place — no session kill, no selection move.
 */
export async function deleteTaskFlow(ctx: TaskActionContext, taskId: string): Promise<void> {
  if (!ctx.orch) return
  const task = ctx.tasks().find((t) => t.id === taskId)
  if (!task) return
  // A "project" row is a synthetic `kind: "main"` task projecting a saved
  // repo. It has no worktree of its own to destroy, and `deleteTask` refuses
  // it (CannotDeleteMainTaskError) — pressing `d` on it used to just error.
  // Route it to forget-project instead: un-save the repo + drop the main row,
  // leaving the repo and any real tasks under it on disk.
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
  // Only tear down the session + move selection if the task was actually
  // removed — a failed/declined delete must leave everything in place.
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

/**
 * Rename a task's title via `task.rename` (same RPC from both hosts). The
 * branch follows the title for not-yet-materialised tasks (autoBranch
 * derives from it); a worktree that already exists keeps its git branch.
 */
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

/**
 * Rename a task's branch via `task.setBranch`. For a materialised worktree
 * the daemon runs `git branch -m` (HEAD moves on the checked-out worktree,
 * a running session keeps streaming); otherwise it just records the name
 * for the eventual `ensureWorktree`. No-op on `main` rows — the project
 * root's branch isn't kobe's to rename. Tasks-pane-only today (`b`), but
 * host-agnostic so the outer monitor could wire it without a port.
 */
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

/**
 * Cycle the task's engine vendor (claude ↔ codex ↔ …) via `task.setVendor`.
 * Takes effect on the task's next enter: `ensureSession` rebuilds a session
 * whose `@kobe_vendor` tag no longer matches, launching the new engine.
 *
 * Cycle over the SAME detected-built-ins + custom set the new-task dialog
 * offers (`availableEngineIds()` + `nextVendorWithin`), not the built-ins
 * alone: a task on a user-added custom engine must be able to cycle back to
 * it instead of jumping to a built-in and getting stranded. Tasks-pane-only
 * today (`v`), lifted host-agnostic like {@link renameBranchFlow}.
 */
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
  // The new vendor only takes effect on the task's NEXT enter (ensureSession
  // rebuilds the pane when its `@kobe_vendor` tag no longer matches), so a
  // bare `v` press looks like a no-op. Surface the deferred-rebuild contract.
  ctx.notifyInfo?.(`Engine → ${engineDisplayName(next)} (applies on reopen)`)
  await ctx.reload?.()
}

/**
 * Create (or adopt) a task through the shared NewTaskDialog flow: default
 * repo → optional surface redirect (Tasks pane chattab tab) → dialog →
 * persist vendor + repo choices → `task.create` / `adoptWorktree` → land
 * the host cursor on the result. The repo auto-save keeps `kobe add`
 * optional: `addSavedRepo` normalizes to the git root + dedupes on disk.
 */
export async function createTaskFlow(ctx: CreateTaskContext): Promise<void> {
  const repos = getSavedRepos()
  // First run (no saved repos): default the dialog to the cwd so the user
  // picks a path in-TUI instead of being sent to a shell for `kobe add`
  // (saved mode preselects it; typing `/` flips to the directory browser).
  // Otherwise default to the host's cursor/active task's repo — the
  // "spawn a sibling" default.
  const defaultRepo = ctx.cursorRepo() ?? repos[0] ?? process.cwd()
  if (ctx.openCreateSurface && (await ctx.openCreateSurface(defaultRepo))) return
  const defaultVendor = ctx.lastVendor() ?? DEFAULT_TASK_VENDOR
  const availableVendors = await availableEngineIds()
  // First-run guard (#24): no built-in engine detected AND no custom engine
  // configured. The dialog would still let the user pick a vendor, then the
  // missing binary surfaces only as a raw shell error inside the pane. Warn
  // up front but still allow proceeding (they may install it after picking).
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
  // Remember the choice so the next new-task dialog — either host —
  // defaults to it (shared state.json; write path is host-provided).
  ctx.rememberVendor(result.vendor)
  // Auto-save the chosen repo so the saved list self-populates and
  // `kobe add` stays optional.
  addSavedRepo(result.repo)
  ctx.onRepoSaved?.()
  if (!orch) {
    ctx.logger.error(`${ctx.logPrefix} no daemon; cannot create task`)
    return
  }
  // The create/adopt awaits a real git-worktree operation with no other
  // feedback — the dialog just vanishes. Surface a transient "working" toast
  // so the wait reads as progress; failure replaces it with the error toast
  // raised in the catch below.
  ctx.notifyInfo?.("Creating task…")
  let createdId: string | undefined
  try {
    if (result.mode === "adopt") {
      // Adopt: import one or more existing worktrees as tasks, then focus
      // the last one (KOB-256).
      for (const w of result.adopt) {
        const t = await orch.adoptWorktree({
          repo: result.repo,
          worktreePath: w.worktreePath,
          branch: w.branch,
          vendor: result.vendor,
        })
        createdId = t.id
      }
    } else {
      const task = await orch.createTask({
        repo: result.repo,
        baseRef: result.baseRef,
        vendor: result.vendor,
      })
      createdId = task.id
    }
  } catch (err) {
    ctx.logger.error(`${ctx.logPrefix} task.create/adopt failed:`, err)
    ctx.notifyError?.(`Couldn't create task: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  await ctx.reload?.()
  // Land the cursor on the new task, then enter it — `n` should drop the user
  // straight into the engine pane ready to type, not just move the selection.
  // (Hosts without `enterTask` fall back to cursor-only.)
  if (createdId) {
    ctx.selectTask?.(createdId)
    await ctx.enterTask?.(createdId)
  }
}
