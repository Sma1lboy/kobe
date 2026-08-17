/**
 * In-place task-field edits for the {@link Orchestrator}.
 *
 * The metadata setters — title, branch, vendor, pinned, archived, status,
 * PR-status, plus sidebar `move` / web-board `reorder` — are each a small
 * guard around one `store` mutation (a few also touch git, for a branch
 * rename). They're cohesive and independent of task creation / worktree
 * allocation, so they live here as a collaborator the Orchestrator holds and
 * delegates to; the Orchestrator keeps thin public methods so its interface is
 * unchanged. Moved verbatim from `core.ts` — no behaviour change.
 */

import { samePrStatus } from "../monitor/pr-status.ts"
import type {
  Task,
  TaskId,
  TaskLinkedWorkItem,
  TaskPRStatus,
  TaskQuotaResumeState,
  TaskStatus,
  VendorId,
} from "../types/task.ts"
import { deriveConventionBranch, inferBranchStyle, uniqueBranchName } from "./branch-style.ts"
import { IllegalTransitionError, TaskNotFoundError } from "./errors.ts"
import type { TaskIndexStore } from "./index/store.ts"
import { isPlaceholderDerivedBranch } from "./title.ts"
import type { GitWorktreeManager } from "./worktree/manager.ts"

/**
 * Owns the Orchestrator's in-place task-field mutations. One per Orchestrator.
 */
export class TaskEditor {
  private readonly store: TaskIndexStore
  private readonly worktrees: GitWorktreeManager

  constructor(store: TaskIndexStore, worktrees: GitWorktreeManager) {
    this.store = store
    this.worktrees = worktrees
  }

  private requireTask(id: TaskId | string): Task {
    const task = this.store.get(id)
    if (!task) throw new TaskNotFoundError(String(id))
    return task
  }

  /** Rename a task. Empty / whitespace-only titles are rejected. Naming a
   *  SCRATCH task is the "keep this" gesture (issue #33) — it clears the
   *  flag, so the row survives its shell exiting. */
  async setTitle(id: TaskId | string, title: string): Promise<void> {
    const trimmed = title.trim()
    if (!trimmed) throw new Error("setTitle: title is required (empty or whitespace-only rejected)")
    const task = this.requireTask(id)
    if (task.title === trimmed && task.scratch !== true) return
    await this.store.update(task.id, { title: trimmed, ...(task.scratch === true ? { scratch: false } : {}) })
    await this.followBranchToTitle(task, trimmed)
  }

  /**
   * Keep a materialised task's branch in lockstep with its title WHILE the
   * branch is still the placeholder-derived default (`new-task`, or a legacy
   * `rove/`/`kobe/` spelling). This is what lets a task auto-named from its
   * first prompt also pick up a meaningful branch. It fires at most
   * once: after the first rename the branch no longer matches the placeholder
   * derivation, so a later title change (or a manual `setBranch`) is never
   * clobbered. Skipped for `main` (no branch) and for not-yet-materialised
   * tasks (their branch is derived fresh from the title in `ensureWorktree`,
   * so no rename is needed).
   *
   * Safety rails (best-effort — a rail bailing or a git failure is logged /
   * swallowed, never thrown; the title update already committed and must
   * stand, and the placeholder branch simply stays):
   *   - never rename a branch that has an upstream (`branch -m` would orphan
   *     the remote branch / any open PR); an unreadable probe counts as
   *     ambiguity and also keeps the old name;
   *   - a collision with an existing local branch resolves to a `-2`, `-3`…
   *     suffixed unique name instead of failing.
   */
  private async followBranchToTitle(taskBefore: Task, newTitle: string): Promise<void> {
    if (taskBefore.kind === "main" || !taskBefore.worktreePath) return
    if (!isPlaceholderDerivedBranch(taskBefore.branch, taskBefore.id)) return
    try {
      const names = await this.worktrees.listBranchNames(taskBefore.repo)
      const base = deriveConventionBranch(newTitle, inferBranchStyle(names))
      if (base === taskBefore.branch) return
      if (await this.worktrees.branchHasUpstream(taskBefore.worktreePath, taskBefore.branch)) return
      // Exclude the branch we're renaming FROM so a placeholder like
      // `new-task` can never block its own successor's `-2` scan.
      const taken = new Set(names.filter((n) => n !== taskBefore.branch))
      const nextBranch = uniqueBranchName(base, taken, taskBefore.id)
      await this.setBranch(taskBefore.id, nextBranch)
    } catch (err) {
      console.error(`[rove] follow-branch-to-title failed for ${taskBefore.id}:`, err)
    }
  }

  /**
   * Rename a task's branch. For a materialised worktree this renames
   * the real git branch (`git branch -m`, which also moves HEAD on the
   * checked-out worktree so a running session keeps streaming); for a
   * not-yet-materialised task it just records the name, which
   * `ensureWorktree` then uses instead of the title-derived
   * default. Rejected for `kind: "main"` (it tracks the repo's own
   * branch — rename that with git directly, not through kobe).
   */
  async setBranch(id: TaskId | string, branch: string): Promise<void> {
    const trimmed = branch.trim()
    if (!trimmed) throw new Error("setBranch: branch is required (empty or whitespace-only rejected)")
    const task = this.requireTask(id)
    if (task.kind === "main") {
      throw new Error("setBranch: a main task tracks the repo's own branch; rename it with git directly")
    }
    if (task.kind === "dir") {
      throw new Error("setBranch: a directory task tracks its own checkout; rename branches with git directly")
    }
    if (task.branch === trimmed) return
    if (task.worktreePath) {
      await this.worktrees.renameBranch(task.worktreePath, task.branch, trimmed)
    }
    await this.store.update(task.id, { branch: trimmed })
  }

  /**
   * Change a task's engine vendor. Pure metadata with no git or process side
   * effects; the next fresh engine session uses the new vendor.
   */
  async setVendor(id: TaskId | string, vendor: VendorId): Promise<void> {
    const task = this.requireTask(id)
    if (task.vendor === vendor) return
    await this.store.update(task.id, { vendor })
  }

  /**
   * Pin a RAW launch command on a task (the dispatch face's `set-command`).
   * Same pure-metadata contract as {@link setVendor}: the next fresh engine
   * session launches it. `vendor` is the command's protocol as resolved by
   * the caller (the CLI, which can read the preset registry); omitting it
   * leaves the recorded protocol alone rather than guessing.
   */
  async setCommand(id: TaskId | string, command: string, vendor?: VendorId): Promise<void> {
    const trimmed = command.trim()
    if (!trimmed) throw new Error("setCommand: command is required (empty or whitespace-only rejected)")
    const task = this.requireTask(id)
    if (task.command === trimmed && (vendor === undefined || task.vendor === vendor)) return
    await this.store.update(task.id, { command: trimmed, ...(vendor ? { vendor } : {}) })
  }

  /** Toggle / set the `pinned` flag. No-op for `kind: "main"` (always pinned). */
  async setPinned(id: TaskId | string, pinned?: boolean): Promise<void> {
    const task = this.requireTask(id)
    if (task.kind === "main") return
    const next = pinned ?? !task.pinned
    if ((task.pinned ?? false) === next) return
    await this.store.update(task.id, { pinned: next })
  }

  /**
   * Move a task up/down within its visible ordering partition. Main
   * (project) rows move among each other — the sidebar's PROJECTS section
   * renders stored order (owner 2026-07-16), so reordering the store IS
   * reordering the list. Regular tasks keep their partition (archived +
   * pinned flags) so a move can't jump groups.
   */
  async moveTask(id: TaskId | string, delta: -1 | 1): Promise<void> {
    const task = this.requireTask(id)
    const isMain = task.kind === "main"
    const groupIds = this.store
      .list()
      .filter((t) =>
        isMain
          ? (t.kind ?? "task") === "main"
          : (t.kind ?? "task") !== "main" &&
            t.archived === task.archived &&
            (t.pinned ?? false) === (task.pinned ?? false),
      )
      .map((t) => String(t.id))
    await this.store.move(task.id, delta, groupIds)
  }

  /**
   * Toggle / set the `archived` flag. No-op for `kind: "main"`: a main
   * task is a saved repo's root, removed by un-saving the repo, not by
   * archiving — mirrors `deleteTask`'s main-row guard so the sidebar's
   * `a` chord can't silently archive (and kill the session of) a whole
   * repo entry from the default cursor row.
   */
  async setArchived(id: TaskId | string, archived?: boolean): Promise<void> {
    const task = this.requireTask(id)
    if (task.kind === "main") return
    const next = archived ?? !task.archived
    if (task.archived === next) return
    await this.store.update(task.id, { archived: next })
  }

  /**
   * Batch-assign web-board positions (docs/design/web-kanban.md M3).
   * Positions are fractional ordering keys consumed ONLY by the web
   * board's per-status columns; the TUI sidebar never reads them. Main
   * rows are never board cards, so they're refused like moveTask.
   * Validation is all-or-nothing: one bad entry fails the whole batch
   * before anything persists.
   */
  async reorderTasks(moves: ReadonlyArray<{ readonly taskId: string; readonly position: number }>): Promise<void> {
    if (moves.length === 0) return
    for (const move of moves) {
      const task = this.requireTask(move.taskId)
      if (task.kind === "main") throw new Error(`cannot reorder a main task: ${move.taskId}`)
      if (!Number.isFinite(move.position)) throw new Error(`position must be a finite number: ${move.taskId}`)
    }
    await this.store.reorder(moves.map((move) => ({ id: move.taskId, position: move.position })))
  }

  /**
   * Move a task between status states. The transitions are not
   * machine-enforced in v0.6 (the user does it from the sidebar) but
   * we still refuse `done` ↔ `error` flip-flops to surface bad code.
   */
  async setStatus(id: TaskId | string, status: TaskStatus): Promise<void> {
    const task = this.requireTask(id)
    if (task.status === status) return
    if ((task.status === "done" && status === "error") || (task.status === "error" && status === "done")) {
      throw new IllegalTransitionError(task.status, status, task.id)
    }
    await this.store.update(task.id, { status })
  }

  /**
   * Set (or clear, with `null`) a task's PR status — driven by the daemon's
   * `pr-status-collector`. Persisting it on the Task means the snapshot push
   * already fans the change to every pane + the web board (no new channel),
   * and it survives a daemon restart. No-op when nothing the UI renders
   * changed (the collector also pre-diffs, but guard here too so a redundant
   * call never churns a write + broadcast).
   */
  async setPRStatus(id: TaskId | string, prStatus: TaskPRStatus | null): Promise<void> {
    const task = this.requireTask(id)
    if (samePrStatus(task.prStatus, prStatus ?? undefined)) return
    await this.store.update(task.id, { prStatus: prStatus ?? undefined })
  }

  /**
   * Arm (or clear, with `null`) the daemon's rate-limit auto-resume schedule.
   * No-op when the stored schedule already matches — the sweep and the hook
   * path may both try to write, and a redundant call must not churn a
   * write + broadcast.
   */
  async setQuotaResume(id: TaskId | string, state: TaskQuotaResumeState | null): Promise<void> {
    const task = this.requireTask(id)
    if ((task.quotaResume?.resumeAt ?? null) === (state?.resumeAt ?? null)) return
    await this.store.update(task.id, { quotaResume: state ?? undefined })
  }

  /** Stamp the external tracker item this task was started from. Write-once in
   *  practice (set at creation); a later call overwrites the snapshot. */
  async setLinkedWorkItem(id: TaskId | string, item: TaskLinkedWorkItem | null): Promise<void> {
    const task = this.requireTask(id)
    if ((task.linkedWorkItem?.url ?? null) === (item?.url ?? null)) return
    await this.store.update(task.id, { linkedWorkItem: item ?? undefined })
  }
}
