/**
 * The shared create/adopt flow behind the NewTaskDialog — split from
 * task-actions.ts (which keeps the mutation flows on EXISTING tasks:
 * archive / delete / rename / vendor). Same testability rule: NO `@opentui`
 * imports; the dialog reaches this module only as the `promptNewTask`
 * adapter callback, so the flow runs under plain vitest with mocks
 * (`test/tui/create-task-flow.test.ts`).
 */

import { availableEngineIds } from "@/engine/account-detect"
import { errorMessage } from "@/lib/error-message"
import { addSavedRepo, getSavedRepos } from "@/state/repos"
import { t } from "@/tui/i18n"
import { DEFAULT_TASK_VENDOR, type VendorId } from "@/types/task"
import type { NewTaskDialogOptions, NewTaskInput } from "../component/new-task-dialog/state"
import type { TaskActionContext } from "./task-actions"

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
  /** Repo-scoped vendor preference — see state/vendor-prefs.ts. */
  readonly lastVendor: (repo: string) => VendorId | undefined
  readonly rememberVendor: (repo: string, vendor: VendorId) => void
  /**
   * DIVERGENCE — after `addSavedRepo`, the outer monitor mirrors the fresh
   * list into its kv store so the debounced whole-store flush doesn't
   * clobber the disk write. The Tasks pane is disk-only and omits this.
   */
  readonly onRepoSaved?: () => void
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

/**
 * Create (or adopt) a task through the shared NewTaskDialog flow: default
 * repo → dialog →
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
  const defaultVendor = ctx.lastVendor(defaultRepo) ?? DEFAULT_TASK_VENDOR
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
  ctx.rememberVendor(result.repo, result.vendor)
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
  if (result.mode === "adopt") {
    // Adopt: import one or more existing worktrees as tasks, focusing the last
    // success. Each adopt is independent — collect per-item results
    // so a later failure can't bury the ones that DID persist behind a generic
    // "couldn't create" toast (they'd be silently invisible). Surface a real
    // N/M summary instead.
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
        if (firstError === undefined) firstError = errorMessage(err)
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
      ctx.notifyError?.(`Couldn't create task: ${errorMessage(err)}`)
      return
    }
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
