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
 *   - `quickForkActiveTask()` — KOB-74. From a focused chat tab, opens
 *     QuickForkDialog seeded with the active task's repo/branch/model,
 *     then creates a child task and dispatches the prompt as its first
 *     turn. Inheritance: repo from source.repo, baseRef from
 *     source.branch (or HEAD for `kind: "main"`), model + vendor +
 *     permissionMode from the source's active tab.
 *   - `confirmRenameTask(taskId)` — opens RenameTaskDialog, calls
 *     `orchestrator.setTitle`.
 *   - `confirmRenameChatTab(tabId)` — opens RenameTaskDialog for the
 *     active task's chat tab, calls `orchestrator.setTabTitle`.
 *   - `confirmDeleteTask(taskId)` — confirms via DialogConfirm; for
 *     pinned "main" tasks it removes the saved-repos entry instead of
 *     deleting the worktree (KOB-15).
 *   - `confirmArchiveTask(taskId)` — confirms before toggling a task
 *     between Working session and Archives.
 *   - `confirmLocalMergeTask(taskId)` — confirms the local-merge intent,
 *     then asks the orchestrator to create a Merge chat tab and inject
 *     the merge prompt.
 *
 * Must be invoked inside a Solid component scope (calls back into
 * dialog stack effects + reads/writes reactive signals).
 */

import type { Accessor } from "solid-js"
import type { KobeOrchestrator } from "../../client/remote-orchestrator.ts"
import { addSavedRepo, removeSavedRepo } from "../../state/repos.ts"
import { NewTaskDialog } from "../component/new-task-dialog"
import { getCurrentBranch } from "../component/new-task-dialog/state"
import { QuickForkDialog } from "../component/quick-fork-dialog"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import type { PaneId } from "../context/focus"
import type { KVContext } from "../context/kv"
import type { DialogContext } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { initialChatModelConfig } from "./task-model-config.ts"

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
  quickForkActiveTask: () => Promise<void>
  confirmRenameTask: (taskId: string) => Promise<void>
  confirmRenameChatTab: (tabId: string) => Promise<void>
  confirmDeleteTask: (taskId: string) => Promise<void>
  confirmArchiveTask: (taskId: string) => Promise<void>
  confirmLocalMergeTask: (taskId: string) => Promise<void>
}

export function useTaskActions(deps: TaskActionsDeps): TaskActions {
  const { orchestrator, dialog, kv, selectedId, setSelectedId, setFocusedPane, savedRepos } = deps

  // Shared "open new-task dialog and create" handler. Bound to two
  // keys with different `enabled` guards (see useBindings calls below).
  async function openNewTaskFlow(): Promise<void> {
    // Default the dialog to the currently-selected task's repo when
    // one is selected — same-repo follow-ups are the common case, so
    // pre-pick the path the user is already looking at. Falls back to
    // the persisted `lastNewTaskRepo`, then to cwd.
    const defaultRepo = (() => {
      const sid = selectedId()
      if (sid) {
        const task = orchestrator.getTask(sid)
        if (task?.repo?.trim()) return task.repo
      }
      const raw = kv.get("lastNewTaskRepo")
      return typeof raw === "string" && raw.trim() ? raw : process.cwd()
    })()
    const defaultCloneParent = (() => {
      const raw = kv.get("lastClonedRepoParent")
      return typeof raw === "string" && raw.trim() ? raw : undefined
    })()
    const result = await NewTaskDialog.show(dialog, defaultRepo, savedRepos(), { defaultCloneParent })
    if (!result) return
    try {
      // Dialog no longer asks for a first prompt — orchestrator gives
      // the task PLACEHOLDER_TASK_TITLE and back-fills it from the
      // user's first composer submit (see runTask). The user lands on
      // the chat composer ready to type.
      const created = await orchestrator.createTask({
        repo: result.repo,
        baseRef: result.baseRef,
        ...initialChatModelConfig(orchestrator.getTask(selectedId() ?? ""), kv),
      })
      kv.set("lastNewTaskRepo", result.repo)
      if (result.cloned) {
        // Persist the parent dir the user picked so the next clone
        // defaults to the same location, and surface the freshly-
        // cloned repo in the existing-tab picker via saved-repos.
        kv.set("lastClonedRepoParent", result.cloned.parentDir)
        try {
          addSavedRepo(result.repo)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("[kobe] addSavedRepo after clone failed:", err)
        }
      }
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
   * KOB-74 — quick-fork the currently selected task. Opens a compact
   * picker dialog seeded with the source task's repo, branch, model,
   * and effort. The dialog lets the user override the model + effort
   * inline before typing the first prompt; on submit, creates a child
   * task that inherits repo + branch (always) and the picked model +
   * effort (potentially different from the source), then dispatches
   * the prompt as the first turn.
   *
   * Inheritance map (defaults — user may override via dialog picker):
   *   - repo        = source.repo (always inherited, no override)
   *   - baseRef     = source.branch when non-empty (regular tasks);
   *                   `getCurrentBranch(source.worktreePath || source.repo)`
   *                   when blank (`kind: "main"` rows) — falls back to
   *                   "main" if HEAD is detached. Always inherited.
   *   - model       = active tab's model (or source.model legacy
   *                   fallback). Default cursor position in dialog;
   *                   user may pick a different model.
   *   - effort      = active tab's modelEffort (or source.modelEffort).
   *                   Default cursor in effort list when applicable.
   *   - permission  = source.permissionMode (preserves plan-mode etc.).
   *                   Always inherited.
   *
   * The new task's first prompt is dispatched immediately via runTask
   * — not parked on the composer's pending-prompt accessor — because
   * the source task may still be streaming and we want the fork to
   * start in parallel without waiting for a composer hydrate.
   *
   * No-ops when no task is selected. Errors are surfaced to stderr.
   */
  async function quickForkActiveTask(): Promise<void> {
    const sourceId = selectedId()
    if (!sourceId) return
    const source = orchestrator.getTask(sourceId)
    if (!source) return
    const activeTab = source.tabs.find((t) => t.id === source.activeTabId) ?? source.tabs[0]
    const inheritedModel = activeTab?.model ?? source.model
    const inheritedEffort = activeTab?.modelEffort ?? source.modelEffort
    const inheritedPermission = source.permissionMode
    // `kind: "main"` rows have `branch === ""` (the live branch is
    // resolved at display time, not stored). Read HEAD directly from
    // the worktreePath (which equals the repo root for main rows) so
    // the fork starts at the same commit the user is actively on.
    const baseRef =
      source.branch && source.branch.length > 0
        ? source.branch
        : (getCurrentBranch(source.worktreePath || source.repo) ?? "main")
    const result = await QuickForkDialog.show(dialog, {
      repo: source.repo,
      baseRef,
      modelId: inheritedModel,
      effort: inheritedEffort,
    })
    if (result === undefined) return
    try {
      const created = await orchestrator.createTask({
        repo: source.repo,
        baseRef,
        prompt: result.prompt,
      })
      // Apply chosen model+effort/permission to the new task's default
      // tab before dispatching the run so the engine spawn uses the
      // intended config from the very first invocation. setModel routes
      // shared model ids through the vendor chosen in the picker.
      const newTabId = created.activeTabId
      await orchestrator
        .setModel(created.id, result.modelId, newTabId, result.effort, result.vendor)
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error("[kobe] quick-fork setModel failed:", err)
        })
      if (inheritedPermission !== undefined) {
        await orchestrator.setPermissionMode(created.id, inheritedPermission).catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error("[kobe] quick-fork setPermissionMode failed:", err)
        })
      }
      // Focus the new task so the user lands on its chat tab while the
      // first turn is starting up — same UX as openNewTaskFlow.
      setSelectedId(created.id)
      setFocusedPane("workspace")
      // Dispatch the first prompt. runTask handles the lazy worktree
      // allocation; the new task switches from `backlog` → `in_progress`
      // and the user starts seeing assistant deltas immediately.
      await orchestrator.runTask(created.id, result.prompt, newTabId)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[kobe] quickForkActiveTask failed:", err)
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
        "remove",
        { initialActive: "cancel" },
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
      "delete",
      { initialActive: "cancel" },
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

  /**
   * Confirm + archive/unarchive a task. Archive is intentionally
   * non-destructive, but it hides the row from the default Working
   * session view, so it still gets an explicit confirmation.
   */
  async function confirmArchiveTask(taskId: string): Promise<void> {
    const task = orchestrator.getTask(taskId)
    if (!task) return
    const nextArchived = !task.archived
    const verb = nextArchived ? "Archive" : "Unarchive"
    const view = nextArchived ? "Archives" : "Working session"
    const ok = await DialogConfirm.show(
      dialog,
      `${verb} '${task.title}'?`,
      nextArchived
        ? "Moves this task to Archives. The worktree, git branch, and chat history stay on disk."
        : "Moves this task back to Working session.",
      "cancel",
      verb.toLowerCase(),
      { initialActive: "cancel" },
    )
    if (ok !== true) return
    try {
      await orchestrator.setArchived(taskId, nextArchived)
      if (!nextArchived) setSelectedId(taskId)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[kobe] move task to ${view} failed:`, err)
    }
  }

  /**
   * Confirm + start a local merge. This is intentionally NOT the PR
   * workflow: the orchestrator injects a prompt into a new Merge chat tab
   * telling the agent to merge the task worktree into `task.repo`.
   */
  async function confirmLocalMergeTask(taskId: string): Promise<void> {
    const task = orchestrator.getTask(taskId)
    if (!task) return
    const target = task.repo.split("/").filter(Boolean).pop() ?? task.repo
    const ok = await DialogConfirm.show(
      dialog,
      `Local merge '${task.title}'?`,
      `Starts a Merge chat tab that asks the agent to merge this task into the parent checkout '${target}'. This does not create a PR or delete the task worktree.`,
      "cancel",
      "merge",
    )
    if (ok !== true) return
    try {
      await orchestrator.requestLocalMerge(taskId)
      setSelectedId(taskId)
      setFocusedPane("workspace")
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[kobe] requestLocalMerge failed:", err)
    }
  }

  return {
    openNewTaskFlow,
    quickForkActiveTask,
    confirmRenameTask,
    confirmRenameChatTab,
    confirmDeleteTask,
    confirmArchiveTask,
    confirmLocalMergeTask,
  }
}
