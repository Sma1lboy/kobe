import { existsSync } from "node:fs"
import { claudePaneIdStrict, currentSessionName, killSession, runTmux, tmuxSessionName } from "@/tmux/client"
import { t } from "@/tui/i18n"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { resolvePreferredVendor, setRepoLastActiveVendor } from "../../state/vendor-prefs.ts"
import type { Task } from "../../types/task.ts"
import { CURRENT_VERSION, type UpdateInfo } from "../../version.ts"
import { HelpDialog } from "../component/help-dialog"
import { NewTaskDialog } from "../component/new-task-dialog"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import { SettingsDialog } from "../component/settings-dialog"
import type { KVContext } from "../context/kv"
import { DEFAULT_SETTINGS_SURFACE, SETTINGS_SURFACE_KEY, normalizeSettingsSurface } from "../lib/settings-surface"
import type { CreateTaskContext } from "../lib/task-actions"
import { HandoverError, enterTask } from "../lib/task-enter.ts"
import { detectWorktreeOpener, openWorktree } from "../lib/worktree-opener"
import {
  openHelpTab,
  openNewTaskTab,
  openSettingsTab,
  openUpdateTab,
  openWorktreesTab,
  refreshKobeWorkspacePanes,
} from "../panes/terminal/tmux.ts"
import type { DialogContext } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"

export interface TasksHostActionsContext {
  readonly tasks: () => readonly Task[]
  readonly orch: RemoteOrchestrator | null
  readonly kv: KVContext
  readonly dialog: DialogContext
  readonly notifyError: (message: string) => void
  readonly notifyInfo: (message: string) => void
  readonly reload: () => Promise<void>
  readonly updateInfo: () => UpdateInfo | null
  readonly setSelectedId: (id: string | null) => void
}

export function worktreeErrorToast(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/not a git repository/i.test(raw)) {
    return t("tasks.toast.worktreeErrorNotGit")
  }
  return t("tasks.toast.worktreeErrorGeneric", { message: raw })
}

export async function openSettingsAction(ctx: TasksHostActionsContext): Promise<void> {
  const surface = normalizeSettingsSurface(ctx.kv.get(SETTINGS_SURFACE_KEY, DEFAULT_SETTINGS_SURFACE))
  if (surface === "chattab") {
    const session = await currentSessionName()
    if (session) {
      await openSettingsTab(session)
      return
    }
  }
  const result = await SettingsDialog.show(ctx.dialog, ctx.kv, ctx.orch ?? undefined)
  if (!result.visualPrefsChanged) return
  if (!ctx.kv.flush()) return
  try {
    const session = await currentSessionName()
    if (session) await refreshKobeWorkspacePanes(session)
  } catch (err) {
    console.error("[kobe tasks] failed to refresh workspace panes:", err)
  }
}

export async function openHelpAction(ctx: TasksHostActionsContext): Promise<void> {
  const session = await currentSessionName()
  if (session) {
    await openHelpTab(session)
    return
  }
  HelpDialog.show(ctx.dialog)
}

export async function openWorktreesAction(): Promise<void> {
  const session = await currentSessionName()
  if (!session) return
  await openWorktreesTab(session)
}

export async function openUpdateAction(ctx: TasksHostActionsContext): Promise<void> {
  const info = ctx.updateInfo()
  if (!info?.hasUpdate) {
    ctx.notifyInfo(t("tasks.toast.alreadyLatest", { version: CURRENT_VERSION }))
    return
  }
  const session = await currentSessionName()
  if (!session) return
  await openUpdateTab(session)
}

export async function openSelectedWorktreeAction(ctx: TasksHostActionsContext, id: string): Promise<void> {
  const task = ctx.tasks().find((t) => t.id === id)
  let worktree = task?.worktreePath
  if (!worktree || !existsSync(worktree)) {
    if (!ctx.orch) {
      console.error("[kobe tasks] no daemon; cannot materialise worktree")
      ctx.notifyError(t("tasks.toast.noDaemonWorktree"))
      return
    }
    try {
      worktree = await ctx.orch.ensureWorktree(id)
    } catch (err) {
      console.error("[kobe tasks] task.ensureWorktree failed:", err)
      ctx.notifyError(worktreeErrorToast(err))
      return
    }
    await ctx.reload()
  }
  if (!worktree || !existsSync(worktree)) return
  const opener = detectWorktreeOpener()
  if (!opener) {
    console.error("[kobe tasks] no editor/opener found; set KOBE_OPEN_EDITOR")
    ctx.notifyError(t("tasks.toast.noEditor"))
    return
  }
  if (!openWorktree(worktree, opener)) {
    console.error(`[kobe tasks] failed to open worktree with ${opener.label}`)
    ctx.notifyError(t("tasks.toast.openWorktreeFailed", { label: opener.label }))
  }
}

export async function focusEnginePaneAction(): Promise<void> {
  if (!process.env.TMUX_PANE) return
  const session = await currentSessionName()
  if (!session) return
  const pane = await claudePaneIdStrict(session)
  if (!pane) return
  await runTmux(["select-pane", "-t", pane])
}

export async function moveTaskAction(ctx: TasksHostActionsContext, id: string, delta: -1 | 1): Promise<void> {
  const task = ctx.tasks().find((t) => t.id === id)
  if (!task || task.kind === "main" || !ctx.orch) return
  try {
    await ctx.orch.moveTask(id, delta)
  } catch (err) {
    console.error("[kobe tasks] task.move failed:", err)
    ctx.notifyError(t("tasks.toast.moveTaskFailed", { message: err instanceof Error ? err.message : String(err) }))
    return
  }
  ctx.setSelectedId(id)
  await ctx.reload()
}

export async function togglePinAction(ctx: TasksHostActionsContext, id: string): Promise<void> {
  if (!ctx.orch) return
  try {
    await ctx.orch.setPinned(id)
  } catch (err) {
    console.error("[kobe tasks] task.pin failed:", err)
    return
  }
  await ctx.reload()
}

export interface SwitchToRef {
  token: number
}

export async function switchToAction(ctx: TasksHostActionsContext, ref: SwitchToRef, id: string): Promise<void> {
  const task = ctx.tasks().find((t) => t.id === id)
  if (!task) return
  const myToken = ++ref.token
  try {
    await enterTask(ctx.orch, task, task.repo, task.vendor, {
      includeInitPrompt: true,
      heal: true,
      captureFrom: true,
      reload: () => ctx.reload(),
      isCurrent: () => ref.token === myToken,
    })
  } catch (err) {
    if (err instanceof HandoverError) {
      if (err.phase === "no-daemon") ctx.notifyError(t("tasks.toast.noDaemonOpen"))
      else if (err.phase === "worktree") ctx.notifyError(worktreeErrorToast(err.cause ?? err))
      else ctx.notifyError(t("tasks.toast.sessionStartFailed"))
    } else {
      console.error("[kobe tasks] switchTo failed:", err)
    }
  }
}

export async function togglePreviewFlowAction(
  ctx: TasksHostActionsContext,
  ref: SwitchToRef,
  id: string,
): Promise<void> {
  const { togglePreviewMode } = await import("@/state/preview-mode")
  togglePreviewMode(id)
  await killSession(tmuxSessionName(id))
  await switchToAction(ctx, ref, id)
}

export interface TaskActionsContextDeps extends TasksHostActionsContext {
  readonly selectedId: () => string | null
  readonly setSelectedId: (id: string | null) => void
  readonly switchTo: (id: string) => Promise<void>
}

export function buildTaskActionsContext(deps: TaskActionsContextDeps): CreateTaskContext {
  return {
    orch: deps.orch,
    tasks: () => deps.tasks(),
    confirm: async (p) =>
      (await DialogConfirm.show(deps.dialog, p.title, p.body, p.cancelLabel, p.confirmLabel)) === true,
    promptText: (initial, opts) => RenameTaskDialog.show(deps.dialog, initial, opts),
    logger: console,
    logPrefix: "[kobe tasks]",
    notifyError: deps.notifyError,
    notifyInfo: deps.notifyInfo,
    reload: () => deps.reload(),
    switchBeforeKill: true,
    updateActiveTask: true,
    onTaskDeleted: (taskId, nextTask) => {
      if (deps.selectedId() !== taskId) return
      const remaining = deps.tasks()
      deps.setSelectedId(nextTask?.id ?? (remaining.find((t) => !t.archived) ?? remaining[0])?.id ?? null)
    },
    promptNewTask: (defaultRepo, repos, opts) => NewTaskDialog.show(deps.dialog, defaultRepo, repos, opts),
    cursorRepo: () => {
      const list = deps.tasks()
      return (list.find((t) => t.id === deps.selectedId()) ?? list[0])?.repo
    },
    lastVendor: (repo) => resolvePreferredVendor(repo),
    rememberVendor: (repo, vendor) => setRepoLastActiveVendor(repo, vendor),
    openCreateSurface: async (defaultRepo) => {
      const surface = normalizeSettingsSurface(deps.kv.get(SETTINGS_SURFACE_KEY, DEFAULT_SETTINGS_SURFACE))
      if (surface !== "chattab") return false
      const session = await currentSessionName()
      if (!session) return false
      await openNewTaskTab(session, defaultRepo)
      return true
    },
    selectTask: (id) => deps.setSelectedId(id),
    enterTask: (id) => deps.switchTo(id),
  }
}
