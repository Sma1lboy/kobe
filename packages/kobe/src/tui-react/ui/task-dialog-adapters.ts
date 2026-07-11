/**
 * Shared adapters both task-action hosts (the workspace host's
 * `useWorkspaceTaskActions` and the Tasks pane's `buildTaskActionsContext`)
 * wire into the framework-free `CreateTaskContext` — the dialog surfacing
 * trio, the post-delete selection move, the repo-scoped vendor preference
 * pair, and the {@link buildBaseCreateTaskContext} base both hosts spread
 * before adding their divergences. Before this module each host carried its
 * own verbatim copy; the flows' behavior is defined in `tui/lib/task-actions`
 * + `tui/lib/task-create-flow`, so these adapters are pure wiring.
 */

import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { resolvePreferredVendor, setRepoLastActiveVendor } from "../../state/vendor-prefs.ts"
import type { ConfirmPrompt, TextPromptOpts } from "../../tui/lib/task-actions"
import type { CreateTaskContext } from "../../tui/lib/task-create-flow"
import type { Task, VendorId } from "../../types/task.ts"
import { NewTaskDialog, type NewTaskDialogOptions } from "../component/new-task-dialog"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import type { DialogContext } from "./dialog"
import { DialogConfirm } from "./dialog-confirm"

/** The three dialog-surfacing callbacks of `TaskActionContext`/`CreateTaskContext`. */
export function taskDialogAdapters(dialog: DialogContext): {
  confirm: (p: ConfirmPrompt) => Promise<boolean>
  promptText: (initial: string, opts?: TextPromptOpts) => Promise<string | undefined>
  promptNewTask: (
    defaultRepo: string,
    repos: readonly string[],
    opts: NewTaskDialogOptions,
  ) => ReturnType<typeof NewTaskDialog.show>
} {
  return {
    confirm: async (p) => (await DialogConfirm.show(dialog, p.title, p.body, p.cancelLabel, p.confirmLabel)) === true,
    promptText: (initial, opts) => RenameTaskDialog.show(dialog, initial, opts),
    promptNewTask: (defaultRepo, repos, opts) => NewTaskDialog.show(dialog, defaultRepo, repos, opts),
  }
}

/** The repo-scoped vendor preference pair (state/vendor-prefs.ts). */
export const vendorPrefAdapters = {
  lastVendor: (repo: string): VendorId | undefined => resolvePreferredVendor(repo),
  rememberVendor: (repo: string, vendor: VendorId): void => setRepoLastActiveVendor(repo, vendor),
} as const

/**
 * `onTaskDeleted` — move the host's cursor off a deleted task: prefer the
 * flow-computed next task, else the first non-archived task, else the first
 * row, else clear. No-op when the deleted task wasn't the cursor.
 */
export function selectNextAfterDelete(args: {
  readonly tasks: () => readonly Task[]
  readonly selectedId: () => string | null
  readonly setSelectedId: (id: string | null) => void
}): (taskId: string, nextTask: Task | undefined) => void {
  return (taskId, nextTask) => {
    if (args.selectedId() !== taskId) return
    const remaining = args.tasks()
    args.setSelectedId(nextTask?.id ?? (remaining.find((t) => !t.archived) ?? remaining[0])?.id ?? null)
  }
}

/** Deps for {@link buildBaseCreateTaskContext} — the wiring both hosts already own. */
export interface BaseCreateTaskContextDeps {
  readonly orch: RemoteOrchestrator | null
  readonly tasks: () => readonly Task[]
  readonly dialog: DialogContext
  readonly notifyError: (message: string) => void
  readonly notifyInfo: (message: string) => void
  readonly selectedId: () => string | null
  readonly setSelectedId: (id: string | null) => void
  /** Forensic log tag — `[kobe tasks]` (Tasks pane) vs `[kobe workspace]`. */
  readonly logPrefix: string
  /** Enter (switch into) a task — the pane's `switchTo` / the workspace's `activateTask`. */
  readonly enterTask: (id: string) => Promise<void>
}

/**
 * The `CreateTaskContext` base both hosts share verbatim: adapters above,
 * console logging, toast wiring, shared active-task publish, post-delete
 * cursor move, cursor-row sibling-repo default, and selection/enter hooks.
 * Hosts spread this and add (or override) only their genuine divergences —
 * the Tasks pane's `reload`/`switchBeforeKill`/`openCreateSurface`, the
 * workspace's tab-snapshot-reclaiming `onTaskDeleted` wrapper.
 */
export function buildBaseCreateTaskContext(deps: BaseCreateTaskContextDeps): CreateTaskContext {
  return {
    orch: deps.orch,
    tasks: () => deps.tasks(),
    ...taskDialogAdapters(deps.dialog),
    ...vendorPrefAdapters,
    logger: console,
    logPrefix: deps.logPrefix,
    notifyError: deps.notifyError,
    notifyInfo: deps.notifyInfo,
    // Publish the shared active-task focus so every surface follows.
    updateActiveTask: true,
    onTaskDeleted: selectNextAfterDelete(deps),
    // "Spawn a sibling" default: the cursor task's repo (fallback: the
    // first listed task's).
    cursorRepo: () => {
      const list = deps.tasks()
      return (list.find((t) => t.id === deps.selectedId()) ?? list[0])?.repo
    },
    // Land the cursor on the new task so Enter / click enters it next.
    selectTask: (id) => deps.setSelectedId(id),
    // Then enter it: `n` drops the user straight into the new task's engine
    // pane, ready to type the first prompt — not just a moved cursor.
    enterTask: (id) => deps.enterTask(id),
  }
}
