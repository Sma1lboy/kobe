/**
 * Workspace-host task-action wiring — React port of `tui/workspace/
 * host-task-actions.ts` (issue #16 React migration). Builds the
 * `CreateTaskContext` the shared `tui/lib/task-actions` flows run on (the
 * SAME framework-free flows the Solid host and the tmux Tasks pane use —
 * confirm copy, DIRTY_WORKTREE force-delete branch, error handling all
 * live there so no host drifts) and returns the host's action callbacks.
 *
 * Only this host's genuine divergences are wired here: dialog surfacing
 * (the React `DialogConfirm`/`RenameTaskDialog`/`NewTaskDialog`), toast
 * notifications, and selection. No `switchBeforeKill` (no tmux client to
 * yank), no `openCreateSurface` (the in-pane NewTaskDialog IS the
 * surface), no `reload` (this host is fully render-driven).
 *
 * Solid→React deltas: every accessor prop (`tasks`, `selectedId`,
 * `selectedTask`) becomes a plain getter closure over the latest render's
 * value — callers pass `() => tasks` / `() => selectedId` etc. from the
 * host, same shape the flows already expect (`TaskActionContext.tasks` is
 * `() => readonly Task[]`), so this file's body is otherwise unchanged
 * from the Solid original.
 */

import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { resolvePreferredVendor, setRepoLastActiveVendor } from "../../state/vendor-prefs.ts"
import { archiveTaskFlow, cycleVendorFlow, deleteTaskFlow, renameTaskFlow } from "../../tui/lib/task-actions"
import { type CreateTaskContext, createTaskFlow } from "../../tui/lib/task-create-flow"
import type { Task } from "../../types/task.ts"
import { BranchPickerDialog } from "../component/branch-picker-dialog"
import { NewTaskDialog } from "../component/new-task-dialog"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import type { DialogContext } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"

export type WorkspaceTaskActionDeps = {
  orchestrator: RemoteOrchestrator
  tasks: () => readonly Task[]
  dialog: DialogContext
  notifyError: (message: string) => void
  notifyInfo: (message: string) => void
  selectedId: () => string | null
  setSelectedId: (id: string | null) => void
  selectedTask: () => Task | undefined
  activateTask: (id: string) => Promise<void>
}

export type WorkspaceTaskActions = {
  createTask: () => Promise<void>
  archiveTask: (id: string) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  renameTask: (id: string) => Promise<void>
  renameBranch: (id: string) => Promise<void>
  cycleVendor: (id: string) => Promise<void>
  togglePin: (id: string) => Promise<void>
  moveTask: (id: string, delta: -1 | 1) => Promise<void>
}

export function useWorkspaceTaskActions(deps: WorkspaceTaskActionDeps): WorkspaceTaskActions {
  const { orchestrator, tasks, dialog, notifyError } = deps

  const taskActions: CreateTaskContext = {
    orch: orchestrator,
    tasks: () => tasks(),
    confirm: async (p) => (await DialogConfirm.show(dialog, p.title, p.body, p.cancelLabel, p.confirmLabel)) === true,
    promptText: (initial, opts) => RenameTaskDialog.show(dialog, initial, opts),
    logger: console,
    logPrefix: "[kobe workspace]",
    notifyError,
    notifyInfo: deps.notifyInfo,
    updateActiveTask: true,
    onTaskDeleted: (taskId, nextTask) => {
      if (deps.selectedId() !== taskId) return
      const remaining = tasks()
      deps.setSelectedId(nextTask?.id ?? (remaining.find((task) => !task.archived) ?? remaining[0])?.id ?? null)
    },
    promptNewTask: (defaultRepo, repos, opts) => NewTaskDialog.show(dialog, defaultRepo, repos, opts),
    cursorRepo: () => deps.selectedTask()?.repo ?? tasks()[0]?.repo,
    lastVendor: (repo) => resolvePreferredVendor(repo),
    rememberVendor: (repo, vendor) => setRepoLastActiveVendor(repo, vendor),
    selectTask: (id) => deps.setSelectedId(id),
    enterTask: (id) => deps.activateTask(id),
  }

  async function togglePin(id: string): Promise<void> {
    const task = tasks().find((t) => t.id === id)
    if (!task) return
    await orchestrator.setPinned(id, !task.pinned).catch((err) => {
      notifyError(`Couldn't pin: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  async function moveTask(id: string, delta: -1 | 1): Promise<void> {
    await orchestrator.moveTask(id, delta).catch((err) => {
      notifyError(`Couldn't move: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  // Set-branch (`b`): pick from the repo's local branches (filter-as-you-type)
  // or type a new name — the shared `renameBranchFlow`'s bare text prompt
  // replaced by the branch-listing dialog (issue #10). `setBranch` no-ops on
  // an unchanged name and rejects a main row, so we only guard/notify here.
  async function renameBranch(id: string): Promise<void> {
    const task = tasks().find((t) => t.id === id)
    if (!task || task.kind === "main") return
    const next = await BranchPickerDialog.show(dialog, { currentBranch: task.branch, repo: task.repo })
    if (!next) return
    await orchestrator.setBranch(id, next).catch((err) => {
      notifyError(`Couldn't rename branch: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  return {
    createTask: () => createTaskFlow(taskActions),
    archiveTask: (id) => archiveTaskFlow(taskActions, id),
    deleteTask: (id) => deleteTaskFlow(taskActions, id),
    renameTask: (id) => renameTaskFlow(taskActions, id),
    renameBranch,
    cycleVendor: (id) => cycleVendorFlow(taskActions, id),
    togglePin,
    moveTask,
  }
}
