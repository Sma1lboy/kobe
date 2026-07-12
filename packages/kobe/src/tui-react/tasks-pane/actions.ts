/**
 * Tasks-pane action bodies — React port of `src/tui/tasks-pane/actions.ts`
 * (issue #15/#16 React migration; React is the default runtime since
 * 2026-07-07). The bodies are framework-free — they take an explicit
 * {@link TasksHostActionsContext} deps bag instead of closing over
 * `TasksShell`'s local state — so this file is the Solid original with only
 * its dialog/context/lib imports swapped to the React (`tui-react/…`)
 * surfaces; the framework-free flows (`tui/lib/task-actions`, `task-enter`,
 * `settings-surface`, `worktree-opener`) and tmux plumbing keep their
 * original paths. `host.tsx` keeps a thin 1-3 line wrapper per function so
 * call sites (JSX props, keybindings) are unchanged.
 */

import { existsSync } from "node:fs"
import { errorMessage } from "@/lib/error-message"
import { claudePaneIdStrict, currentSessionName, killSession, runTmux, tmuxSessionName } from "@/tmux/client"
import { t } from "@/tui/i18n"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import {
  DEFAULT_SETTINGS_SURFACE,
  SETTINGS_SURFACE_KEY,
  normalizeSettingsSurface,
} from "../../tui/lib/settings-surface"
import type { CreateTaskContext } from "../../tui/lib/task-create-flow"
import { HandoverError, enterTask } from "../../tui/lib/task-enter"
import { detectWorktreeOpener, openWorktree } from "../../tui/lib/worktree-opener"
import {
  openHelpTab,
  openNewTaskTab,
  openSettingsTab,
  openUpdateTab,
  openWorktreesTab,
  refreshKobeWorkspacePanes,
} from "../../tui/panes/terminal/tmux"
import type { Task } from "../../types/task.ts"
import { CURRENT_VERSION, type UpdateInfo } from "../../version.ts"
import { HelpDialog } from "../component/help-dialog"
import { SettingsDialog } from "../component/settings-dialog"
import type { KVContext } from "../context/kv"
import type { DialogContext } from "../ui/dialog"
import { buildBaseCreateTaskContext } from "../ui/task-dialog-adapters"

/** Deps every action below needs, built once per `TasksShell` render. */
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

/**
 * Toast text for a failed `ensureWorktree`. The new-task dialog blocks
 * non-git repos pre-submit, but tasks created via other entry points (CLI,
 * adopted state) can still reach here with a bare `fatal: not a git
 * repository`. Translate that into the real reason — a task is a git
 * worktree + branch, so for now the project must already be a git repo
 * (non-git roots are a planned follow-up) — instead of leaking git's stderr.
 */
export function worktreeErrorToast(err: unknown): string {
  const raw = errorMessage(err)
  if (/not a git repository/i.test(raw)) {
    return t("tasks.toast.worktreeErrorNotGit")
  }
  return t("tasks.toast.worktreeErrorGeneric", { message: raw })
}

/**
 * Settings opens on the user's chosen surface (default chattab): a
 * dedicated full-window `kobe settings` page opened as a new tmux tab,
 * or the in-pane SettingsDialog overlay. If we can't resolve our tmux
 * session (e.g. running outside a kobe pane), fall back to the overlay.
 */
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

/**
 * F1 help opens as a dedicated full-window tab (like Settings) — the
 * in-pane HelpDialog overlay only had the narrow Tasks rail to render
 * in, which truncated every keybinding row. Fall back to the overlay
 * when we can't resolve our tmux session (e.g. running outside a kobe
 * pane).
 */
export async function openHelpAction(ctx: TasksHostActionsContext): Promise<void> {
  const session = await currentSessionName()
  if (session) {
    await openHelpTab(session)
    return
  }
  HelpDialog.show(ctx.dialog)
}

/**
 * Worktree management always opens as a dedicated full-window tab — no
 * in-pane overlay exists for it (unlike Settings/Help), so the rare
 * no-tmux-session case (running outside a kobe pane) is a silent no-op,
 * matching `openUpdateAction`'s same-shaped fallback. Needs no deps —
 * pure tmux session lookup.
 */
export async function openWorktreesAction(): Promise<void> {
  const session = await currentSessionName()
  if (!session) return
  await openWorktreesTab(session)
}

export async function openUpdateAction(ctx: TasksHostActionsContext): Promise<void> {
  const info = ctx.updateInfo()
  if (!info?.hasUpdate) {
    // The `u` chord / update chip would otherwise no-op silently when
    // nothing is pending — confirm the up-to-date state instead (#23a).
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

/**
 * Right arrow → re-focus THIS window's engine (claude/codex) pane, the
 * inverse of ctrl+h. Targeting: the role-tagged lookup
 * (`claudePaneIdStrict` → `@kobe_role=claude`, vendor-neutral) is the
 * honest "current window's engine pane" — `paneIdByRole` lists the
 * session's ACTIVE window, which is necessarily the window holding this
 * pane (we only receive the keystroke while active), so no window
 * derivation from $TMUX_PANE is needed. No-op outside tmux (standalone
 * `kobe tasks` has no $TMUX_PANE) or when the window has no tagged
 * engine pane (legacy session). Needs no deps — pure tmux lookup.
 */
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
    ctx.notifyError(t("tasks.toast.moveTaskFailed", { message: errorMessage(err) }))
    return
  }
  ctx.setSelectedId(id)
  await ctx.reload()
}

/**
 * Pin / unpin the cursor task (Shift+P). `setPinned` with no explicit flag
 * toggles daemon-side; reload mirrors the new order into the poll fallback,
 * matching how archive/delete refresh the list. No-op without a daemon.
 * A pin failure is log-only (like focusEnginePane): it's rare, non-destructive,
 * and there's no dedicated toast key in the tasks-pane message namespace.
 */
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

/** Monotonic switch-token holder — a newer `switchToAction` supersedes any
 *  still-in-flight one. Lives as a mutable ref in `host.tsx` (one per
 *  `TasksShell` instance) since it's genuinely local mutable state, not a
 *  dep other actions read. */
export interface SwitchToRef {
  token: number
}

/**
 * Enter / click on a task → switch this tmux client to that task's session,
 * creating it on demand. The full enter loop:
 *   1. session running → just switch-client.
 *   2. session gone but worktree on disk → ensureSession + switch.
 *   3. backlog task, no worktree yet → materialise it via the daemon's
 *      `task.ensureWorktree` RPC (git worktree add — only the Orchestrator
 *      can do it), then ensureSession + switch.
 * Step 3 closes the create→enter loop entirely inside the Tasks pane (a task
 * you just made with `n` is enterable here, no detour through the outer
 * monitor).
 */
export async function switchToAction(ctx: TasksHostActionsContext, ref: SwitchToRef, id: string): Promise<void> {
  const task = ctx.tasks().find((t) => t.id === id)
  if (!task) return
  // Monotonic switch token: a newer switchTo supersedes any still-in-flight
  // one. enterTask checks `isCurrent` before its disruptive setActive +
  // switch-client, so a slow cold-session switch that finishes after a later
  // click can't drag the active task (and thus the home pane's selection)
  // back to the superseded project. (Fixes the "click A → click B → top-left
  // selection sticks on A" race.)
  const myToken = ++ref.token
  // The whole enter sequence (capture from-layout → ensure/heal session →
  // zen → setActive → fit + switch) lives in the Handover owner; the Tasks
  // pane opts into capture + heal and reloads its mirror after a cold
  // worktree materialise. `includeInitPrompt: true` keeps prior switchTo
  // behaviour (always weave the marker-guarded repo-init). enterTask throws a
  // HandoverError on a build failure; we map its phase to the right toast.
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

/**
 * `i` — flip a task between the live read-only preview and the engine. The
 * mode is read when the session is built and a healthy session is reused
 * as-is, so kill this task's session to force a rebuild in the new mode, then
 * switch into it to show the result. killSession no-ops when none exists.
 */
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

/** Deps `buildTaskActionsContext` needs beyond what's already in {@link TasksHostActionsContext}. */
export interface TaskActionsContextDeps extends TasksHostActionsContext {
  readonly selectedId: () => string | null
  readonly setSelectedId: (id: string | null) => void
  readonly switchTo: (id: string) => Promise<void>
}

/**
 * Build the `lib/task-actions.ts` `CreateTaskContext` for the Tasks pane. The
 * flow bodies (confirm copy, DIRTY_WORKTREE force-delete branch, error
 * handling) live in that shared module so this pane and the deprecated outer
 * monitor can't drift apart — what's built here is only what's genuinely
 * this host's: dialog wiring, toast surfacing, disk-only persistence, the
 * chattab create surface, and selection.
 */
export function buildTaskActionsContext(deps: TaskActionsContextDeps): CreateTaskContext {
  return {
    // Dialogs show IN the Tasks pane without zooming it full-window: the
    // dialog overlay caps to the pane width (`maxWidth = dimensions().width
    // - 2`), so it renders fine in the ~22%-wide pane — just narrower — and
    // the other panes stay visible. Disk-only vendor persistence (no
    // in-process kv store), so no onRepoSaved kv mirror is needed.
    ...buildBaseCreateTaskContext({ ...deps, logPrefix: "[kobe tasks]", enterTask: deps.switchTo }),
    reload: () => deps.reload(),
    // This pane runs INSIDE the tmux client whose session a delete kills —
    // switch away first so the kill doesn't yank the user's terminal.
    // Same surface preference as Settings (default chattab): open the
    // new-task flow as a dedicated full-window page in a new tmux tab.
    // The page performs the create/adopt itself and the subscribe pushes
    // the new task back into this list. Fall back to the in-pane overlay
    // if we can't resolve our tmux session.
    openCreateSurface: async (defaultRepo) => {
      const surface = normalizeSettingsSurface(deps.kv.get(SETTINGS_SURFACE_KEY, DEFAULT_SETTINGS_SURFACE))
      if (surface !== "chattab") return false
      const session = await currentSessionName()
      if (!session) return false
      await openNewTaskTab(session, defaultRepo)
      return true
    },
  }
}
