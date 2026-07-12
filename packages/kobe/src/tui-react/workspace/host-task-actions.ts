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
 * notifications and selection. No `openCreateSurface` (the in-pane NewTaskDialog IS the
 * surface), no `reload` (this host is fully render-driven).
 *
 * Solid→React deltas: every accessor prop (`tasks`, `selectedId`,
 * `selectedTask`) becomes a plain getter closure over the latest render's
 * value — callers pass `() => tasks` / `() => selectedId` etc. from the
 * host, same shape the flows already expect (`TaskActionContext.tasks` is
 * `() => readonly Task[]`), so this file's body is otherwise unchanged
 * from the Solid original.
 */

import { errorMessage } from "@/lib/error-message"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { archiveTaskFlow, cycleVendorFlow, deleteTaskFlow, renameTaskFlow } from "../../tui/lib/task-actions"
import { type CreateTaskContext, createTaskFlow } from "../../tui/lib/task-create-flow"
import type { Task } from "../../types/task.ts"
import { BranchPickerDialog } from "../component/branch-picker-dialog"
import type { DialogContext } from "../ui/dialog"
import { buildBaseCreateTaskContext, selectNextAfterDelete } from "../ui/task-dialog-adapters"

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
  /** Reclaim a deleted task's terminal-tab snapshot (O19). Delete only —
   *  archive keeps the snapshot for unarchive --resume. */
  forgetTaskTabs: (taskId: string) => void
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
    ...buildBaseCreateTaskContext({
      orch: orchestrator,
      tasks,
      dialog,
      notifyError,
      notifyInfo: deps.notifyInfo,
      selectedId: deps.selectedId,
      setSelectedId: deps.setSelectedId,
      logPrefix: "[kobe workspace]",
      enterTask: deps.activateTask,
    }),
    onTaskDeleted: (() => {
      // Reclaim the deleted task's terminal-tab snapshot (O19), THEN move the
      // host cursor off it (the shared selection move — the base's bare
      // `selectNextAfterDelete` overridden with this wrapper).
      const moveSelection = selectNextAfterDelete({
        tasks,
        selectedId: deps.selectedId,
        setSelectedId: deps.setSelectedId,
      })
      return (taskId: string, nextTask: Task | undefined) => {
        deps.forgetTaskTabs(taskId)
        moveSelection(taskId, nextTask)
      }
    })(),
  }

  async function togglePin(id: string): Promise<void> {
    const task = tasks().find((t) => t.id === id)
    if (!task) return
    await orchestrator.setPinned(id, !task.pinned).catch((err) => {
      notifyError(`Couldn't pin: ${errorMessage(err)}`)
    })
  }

  async function moveTask(id: string, delta: -1 | 1): Promise<void> {
    await orchestrator.moveTask(id, delta).catch((err) => {
      notifyError(`Couldn't move: ${errorMessage(err)}`)
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
      notifyError(`Couldn't rename branch: ${errorMessage(err)}`)
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
