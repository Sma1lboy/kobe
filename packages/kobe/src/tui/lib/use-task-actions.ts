/**
 * User-action handlers wrapped over the orchestrator — every "user
 * verb that flows through a dialog and an orchestrator call" lives
 * here. Bundled into a single hook so Shell + the app-keymap can both
 * consume the same set of functions without duplicate wiring.
 *
 * Handlers:
 *
 *   - `openNewTaskFlow()` — opens NewTaskDialog, calls
 *     `orchestrator.createTask`, persists the last-repo, focuses the
 *     workspace pane.
 *   - `confirmRenameTask(taskId)` — opens RenameTaskDialog, calls
 *     `orchestrator.setTitle`.
 *   - `confirmRenameChatTab(tabId)` — opens RenameTaskDialog for the
 *     active task's chat tab, calls `orchestrator.setTabTitle`.
 *   - `confirmDeleteTask(taskId)` — confirms via DialogConfirm; for
 *     pinned "main" tasks it removes the saved-repos entry instead of
 *     deleting the worktree (KOB-15).
 *
 * Must be invoked inside a Solid component scope (calls back into
 * dialog stack effects + reads/writes reactive signals).
 */

import type { Accessor } from "solid-js"
import type { KobeOrchestrator } from "../../client/remote-orchestrator.ts"
import { removeSavedRepo } from "../../state/repos.ts"
import { NewTaskDialog } from "../component/new-task-dialog"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import type { PaneId } from "../context/focus"
import type { KVContext } from "../context/kv"
import type { DialogContext } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"

export type TaskActionsDeps = {
  orchestrator: KobeOrchestrator
  dialog: DialogContext
  kv: KVContext
  /** Currently-selected task id (or null). */
  selectedId: Accessor<string | null>
  setSelectedId: (id: string | null) => void
  setFocusedPane: (id: PaneId) => void
  /** Saved-repos list — read to populate the new-task dialog's repo picker. */
  savedRepos: Accessor<readonly string[]>
}

export type TaskActions = {
  openNewTaskFlow: () => Promise<void>
  confirmRenameTask: (taskId: string) => Promise<void>
  confirmRenameChatTab: (tabId: string) => Promise<void>
  confirmDeleteTask: (taskId: string) => Promise<void>
}

export function useTaskActions(deps: TaskActionsDeps): TaskActions {
  const { orchestrator, dialog, kv, selectedId, setSelectedId, setFocusedPane, savedRepos } = deps

  // Shared "open new-task dialog and create" handler. Bound to two
  // keys with different `enabled` guards (see useBindings calls below).
  async function openNewTaskFlow(): Promise<void> {
    // Default the dialog to the last repo the user picked, falling
    // back to cwd. Persisted via KV so it survives kobe restarts.
    const lastRepo = (() => {
      const raw = kv.get("lastNewTaskRepo")
      return typeof raw === "string" && raw.trim() ? raw : process.cwd()
    })()
    const result = await NewTaskDialog.show(dialog, lastRepo, savedRepos())
    if (!result) return
    try {
      // Dialog no longer asks for a first prompt — orchestrator gives
      // the task PLACEHOLDER_TASK_TITLE and back-fills it from the
      // user's first composer submit (see runTask). The user lands on
      // the chat composer ready to type.
      const created = await orchestrator.createTask({
        repo: result.repo,
        baseRef: result.baseRef,
      })
      kv.set("lastNewTaskRepo", result.repo)
      setSelectedId(created.id)
      // Pull focus to the chat pane so the user can immediately type
      // / use chat-pane-scoped keybindings (ctrl+t for new chat tab,
      // ctrl+1..9 / ctrl+tab to navigate tabs, ctrl+w to close one)
      // without an extra ctrl+2. Mirrors the sidebar's onSelect
      // behaviour — both "user wants to look at this task" entry
      // points should land in the same place.
      setFocusedPane("workspace")
    } catch (err) {
      // Surface failure as stderr; we don't have a global banner yet,
      // and the chat pane may not be subscribed (no task selected).
      // eslint-disable-next-line no-console
      console.error("[kobe] createTask failed:", err)
    }
  }

  /**
   * Open the rename dialog for a task and persist the new title.
   * Mirrors `confirmDeleteTask` in shape: resolve task → run dialog →
   * await orchestrator. The orchestrator's `setTitle` does its own
   * empty-title rejection and same-as-current no-op, so we only need
   * to gate on "did the user submit a value at all" here. The dialog
   * itself rejects empty submits before calling onSubmit, so a
   * resolved-with-string from the promise is always usable.
   */
  async function confirmRenameTask(taskId: string): Promise<void> {
    const task = orchestrator.getTask(taskId)
    if (!task) return
    const next = await RenameTaskDialog.show(dialog, task.title)
    if (next === undefined) return
    try {
      await orchestrator.setTitle(taskId, next)
    } catch (err) {
      // Empty/whitespace-only — defensive: dialog's commit() filters
      // these but a future code path could call this with anything.
      // eslint-disable-next-line no-console
      console.error("[kobe] setTitle failed:", err)
    }
  }

  /**
   * Open the rename dialog for the active chat tab on the active task
   * and persist the new label. Mirrors `confirmRenameTask` shape but
   * targets `tabs[i].title` instead of `task.title`. Pre-fills with
   * the current label (or the auto-derived `chat N` fallback if the
   * tab has never been named).
   */
  async function confirmRenameChatTab(tabId: string): Promise<void> {
    const taskId = selectedId()
    if (!taskId) return
    const task = orchestrator.getTask(taskId)
    if (!task) return
    const tab = task.tabs.find((t) => t.id === tabId)
    if (!tab) return
    const fallback = `chat ${tab.seq}`
    const current = tab.title && tab.title.length > 0 ? tab.title : fallback
    const next = await RenameTaskDialog.show(dialog, current, { dialogTitle: "Rename chat tab" })
    if (next === undefined) return
    try {
      await orchestrator.setTabTitle(taskId, tabId, next)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[kobe] setTabTitle failed:", err)
    }
  }

  /**
   * Confirm + delete a task. Wired from the sidebar's `d` keypress
   * (and a future right-click in Wave 4). Per CLAUDE.md the user's
   * `d` press IS the explicit consent for clearing the worktree, but
   * we still gate behind a confirm because the action is destructive
   * and out-of-frame state (other terminal windows, in-progress writes)
   * could mean "press the wrong key once" → "lose work."
   *
   * KOB-15: pressing `d` on a pinned "main" task row does NOT delete
   * the user's actual repo. Instead the row is bound to a saved-
   * repos entry; the destructive verb is "remove from saved repos."
   * The directory and its files stay on disk; the task is archived
   * (not removed from the manifest) so a re-add via `kobe add` is
   * symmetric — `ensureMainTask` finds and unarchives it.
   */
  async function confirmDeleteTask(taskId: string): Promise<void> {
    const task = orchestrator.getTask(taskId)
    if (!task) return
    if (task.kind === "main") {
      const repoLabel = task.repo.split("/").filter(Boolean).pop() ?? task.repo
      const ok = await DialogConfirm.show(
        dialog,
        `Remove '${repoLabel}' from saved repos?`,
        `This will remove '${repoLabel}' from your saved repos. The directory and its files stay on disk.`,
        "cancel",
      )
      if (ok !== true) return
      try {
        removeSavedRepo(task.repo)
        await orchestrator.setArchived(task.id, true)
        if (selectedId() === task.id) setSelectedId(null)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[kobe] remove saved repo failed:", err)
      }
      return
    }
    const ok = await DialogConfirm.show(
      dialog,
      `Delete '${task.title}'?`,
      `Removes the worktree at ${task.worktreePath}, deletes the chat history, and removes the task. This cannot be undone. The git branch is kept.`,
      "cancel",
    )
    if (ok !== true) return
    try {
      await orchestrator.deleteTask(taskId)
      // If the deleted task was the selected one, clear selection so the
      // chat pane / file tree etc. stop pointing at a dead worktree.
      if (selectedId() === taskId) setSelectedId(null)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[kobe] deleteTask failed:", err)
    }
  }

  return {
    openNewTaskFlow,
    confirmRenameTask,
    confirmRenameChatTab,
    confirmDeleteTask,
  }
}
