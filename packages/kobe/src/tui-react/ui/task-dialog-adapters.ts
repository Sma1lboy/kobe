/**
 * Shared adapters both task-action hosts (the workspace host's
 * `useWorkspaceTaskActions` and the Tasks pane's `buildTaskActionsContext`)
 * wire into the framework-free `CreateTaskContext` — the dialog surfacing
 * trio, the post-delete selection move, and the repo-scoped vendor
 * preference pair. Before this module each host carried its own verbatim
 * copy; the flows' behavior is defined in `tui/lib/task-actions` +
 * `tui/lib/task-create-flow`, so these adapters are pure wiring.
 */

import { resolvePreferredVendor, setRepoLastActiveVendor } from "../../state/vendor-prefs.ts"
import type { ConfirmPrompt, TextPromptOpts } from "../../tui/lib/task-actions"
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
