/**
 * Framework-free Task and Worktree orchestrator. It owns lifecycle metadata,
 * lazy Worktree allocation, and the reactive snapshot clients subscribe to.
 * Interactive engine processes and Terminal Tab state have separate owners.
 */

import { type ReadableState, type StateCell, createStateCell } from "../lib/external-store.ts"
import { readLastActiveTaskId, writeLastActiveTaskId } from "../state/last-active.ts"
import { getRemoteRepoConfig, getSavedRepos, removeSavedRepo } from "../state/repos.ts"
import { resolvePreferredVendor } from "../state/vendor-prefs.ts"
import type { Task, TaskId, TaskPRStatus, TaskStatus, VendorId } from "../types/task.ts"
import { DEFAULT_TASK_VENDOR } from "../types/task.ts"
import type { AdoptableWorktree } from "../types/worktree.ts"
import { canonPath, normalizeMainRepo, titleFromRepo } from "./core-helpers.ts"
import { DirtyWorktreeError, TaskDeletingError, TaskNotFoundError, WorktreeRemoveFailedError } from "./errors.ts"
import type { TaskIndexStore, TaskIndexUnsubscribe } from "./index/store.ts"
import { type LandResult, type LandTaskOpts, landTaskWithCleanup } from "./land.ts"
import { TaskDeletionCoordinator } from "./task-deletion.ts"
import { TaskEditor } from "./task-editor.ts"
import { PLACEHOLDER_TASK_TITLE } from "./title.ts"
import { WorktreeCoordinator } from "./worktree-coordinator.ts"
import type { GitWorktreeManager } from "./worktree/manager.ts"

/**
 * The on-disk working dir a project key resolves to: the local repo path, or a
 * remote project's `basePath` (the ssh:// key isn't a usable path). The main
 * task and the engine's `cd` target both key off this.
 */
function repoWorkingDir(repo: string): string {
  return getRemoteRepoConfig(repo)?.basePath ?? repo
}

/** Input to {@link Orchestrator.createTask}. */
export interface CreateTaskInput {
  readonly repo: string
  /** Title for the sidebar row. Defaults to `(new task)` when omitted. */
  readonly title?: string
  /** Branch override; otherwise an auto branch is generated lazily. */
  readonly branch?: string
  /** Optional base ref for the new lazy worktree branch. */
  readonly baseRef?: string
  /** Engine vendor for the monitor's history-reader hint. */
  readonly vendor?: VendorId
  /** Reasoning/effort level for the engine, when the vendor supports one. */
  readonly modelEffort?: string
}

export type Unsubscribe = () => void
export type TaskListListener = (snapshot: readonly Task[]) => void

export interface OrchestratorDeps {
  readonly store: TaskIndexStore
  readonly worktrees: GitWorktreeManager
}

// Re-exported from `title.ts` (its single source of truth) so existing
// importers of `PLACEHOLDER_TASK_TITLE` from `core.ts` keep working.
export { PLACEHOLDER_TASK_TITLE }

/**
 * Owner of the task lifecycle.
 *
 * Single source of truth for: which tasks exist, which worktree each
 * lives in, what its status / archived / pinned flag is. The TUI
 * subscribes via {@link tasksSignal} or {@link subscribeTasks}.
 */
export class Orchestrator {
  private readonly store: TaskIndexStore
  private readonly worktrees: GitWorktreeManager
  /** Owns git-worktree side-effects (allocate / materialise / adopt) + their locks. */
  private readonly worktreeCoordinator: WorktreeCoordinator
  /** Owns in-place task-field edits (title / branch / vendor / status / …). */
  private readonly editor: TaskEditor
  private readonly deletions: TaskDeletionCoordinator
  private readonly tasksAcc: StateCell<Task[]>
  private readonly activeTaskAcc: StateCell<string | null>
  private readonly unsubscribeStore: TaskIndexUnsubscribe
  /** Lock for `ensureMainTask` so concurrent calls don't double-create. */
  private readonly mainTaskLocks = new Map<string, Promise<Task>>()

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store
    this.worktrees = deps.worktrees
    this.worktreeCoordinator = new WorktreeCoordinator(this.store, this.worktrees, canonPath, (repo) =>
      this.ensureMainTask(repo),
    )
    this.editor = new TaskEditor(this.store, this.worktrees)
    this.deletions = new TaskDeletionCoordinator(this.store, this.worktrees, (id) =>
      this.worktreeCoordinator.forget(id),
    )
    this.tasksAcc = createStateCell<Task[]>(this.store.list())
    // Seed focus from the persisted `lastActive` record (state/last-active
    // .ts) so a daemon restart or fresh TUI opens on the last-focused task
    // instead of "first in the list". Dropped silently when the task is
    // gone (deleted since) — the UI's own fallback picks a survivor.
    const persistedFocus = readLastActiveTaskId()
    this.activeTaskAcc = createStateCell<string | null>(
      persistedFocus && this.store.get(persistedFocus) ? persistedFocus : null,
    )
    this.unsubscribeStore = this.store.subscribe((snapshot) => {
      this.tasksAcc.set(snapshot.slice())
    })
  }

  /**
   * Pre-flight hook for the TUI to await before the first render.
   * Currently a no-op — kept for API parity with the v0.5 daemon
   * orchestrator + future expansion.
   */
  async init(): Promise<void> {
    // No-op in v0.6. v0.5 had startup polling for plan-usage and rc-bridge;
    // both are gone. The TUI awaits this for parity.
  }

  /**
   * The active-task focus, in-process. Mirrors {@link RemoteOrchestrator}'s
   * daemon-backed `active-task` channel so the `KobeOrchestrator` union has
   * one API; in this local (no-daemon) mode there are no sibling panes to
   * sync, so it's just an in-process signal.
   */
  activeTaskSignal(): ReadableState<string | null> {
    return this.activeTaskAcc
  }

  /** Set the active-task focus and touch recency for task-list sorting. */
  async setActiveTask(id: TaskId | string | null): Promise<void> {
    const next = id === null ? null : String(id)
    if (next && this.store.get(next)?.deletion) throw new TaskDeletingError(next)
    this.activeTaskAcc.set(next)
    if (next && this.store.get(next)) {
      // Global last-writer-wins focus record — see state/last-active.ts. This
      // eagerly persists the ONE last-focused id, so a daemon/TUI restart
      // reopens on it regardless of the lazy recency flush below.
      writeLastActiveTaskId(next)
      // Recency bump for the sidebar's `recent` sort ONLY. Deliberately NOT a
      // `store.update(next, {})`: that empty patch still ran a full fsync'd
      // read-merge-write on every focus switch (the single most frequent
      // action) to move `updatedAt`, which the DEFAULT sort never reads.
      // `touchRecency` bumps `updatedAt` in-cache + notifies listeners (so
      // `recent` reorders live) but flushes lazily on the next real mutation —
      // dropping the per-switch fsync'd disk rewrite + full-list broadcast churn.
      this.store.touchRecency(next)
    }
  }

  /** Solid signal of the current task list. */
  tasksSignal(): ReadableState<Task[]> {
    return this.tasksAcc
  }

  /**
   * Subscribe to task-list updates. Fires once with the current snapshot as
   * soon as it's available — eagerly here if the store is already loaded, else
   * from the store's own `load()` notification — then again after every
   * mutation.
   *
   * We must NOT also fire the listener directly: the store already delivers
   * that first snapshot (eagerly on subscribe when loaded, via load() otherwise).
   * A direct fire on top double-published `task.snapshot` on daemon boot, and on
   * the not-yet-loaded path it threw (the store's `list()` asserts loaded).
   */
  subscribeTasks(listener: TaskListListener): Unsubscribe {
    return this.store.subscribe(listener)
  }

  dispose(): void {
    this.unsubscribeStore()
  }

  // --- read ---

  listTasks(): Task[] {
    return this.store.list()
  }

  getTask(id: TaskId | string): Task | undefined {
    return this.store.get(id)
  }

  // --- write ---

  /**
   * Create a new task entry. Worktree allocation is lazy — the
   * `worktreePath` field stays empty until {@link ensureWorktree} is
   * called (typically when the user enters the task for the first
   * time).
   */
  async createTask(input: CreateTaskInput): Promise<Task> {
    if (!input.repo) throw new Error("createTask: repo is required")
    // A task whose repo has no `kind:"main"` task is unrenderable state:
    // the sidebar's PROJECTS rows ARE the main tasks (sidebar/groups.ts),
    // so a task created for a brand-new repo would float with no project
    // row. Every creation path therefore guarantees its own project entry.
    await this.ensureMainTask(input.repo)
    const title = (input.title ?? PLACEHOLDER_TASK_TITLE).trim() || PLACEHOLDER_TASK_TITLE
    // Leave the branch EMPTY for a lazily-allocated task (unless the caller
    // gave an explicit one): {@link ensureWorktree} derives a unique
    // `kobe/<slug>-<id>` from the task's OWN id when the worktree
    // materialises. We must NOT pre-derive a branch here — at create time
    // there is no task id yet, so every placeholder-titled task would get
    // the SAME name (`kobe/new-task-…`) and the second `git worktree add
    // -b` would fail on a duplicate branch. Deferring also lets
    // the branch follow a rename made before first enter.
    const task = await this.store.create({
      repo: input.repo,
      title,
      branch: input.branch ?? "",
      worktreePath: "",
      status: "backlog",
      kind: "task",
      vendor: input.vendor ?? DEFAULT_TASK_VENDOR,
      ...(input.modelEffort ? { modelEffort: input.modelEffort } : {}),
    })
    // Remember the optional baseRef on a side-map so `ensureWorktree`
    // can use it. Not on the Task itself: base-ref is one-shot input
    // to the worktree create, not durable state.
    if (input.baseRef) this.worktreeCoordinator.setPendingBaseRef(task.id, input.baseRef)
    return task
  }

  /**
   * Ensure a `kind: "main"` task exists for the given repo. Idempotent.
   * The main task is pinned to the repo root (no `git worktree add`)
   * and lives at the top of the sidebar.
   */
  async ensureMainTask(repo: string): Promise<Task> {
    const { repo: normalizedRepo, key } = normalizeMainRepo(repo)
    const existing = this.store.list().find((t) => t.kind === "main" && normalizeMainRepo(t.repo).key === key)
    if (existing) return existing
    const inflight = this.mainTaskLocks.get(key)
    if (inflight) return inflight
    const promise = (async () => {
      // A project's main chat opens with the repo's preferred engine
      // (per-repo last-active → global default → claude).
      const vendor = resolvePreferredVendor(normalizedRepo)
      const created = await this.store.create({
        repo: normalizedRepo,
        title: titleFromRepo(normalizedRepo),
        branch: "",
        // Remote main task lives at the remote basePath, not the ssh:// key.
        worktreePath: repoWorkingDir(normalizedRepo),
        status: "backlog",
        kind: "main",
        vendor,
      })
      return created
    })()
    this.mainTaskLocks.set(key, promise)
    try {
      return await promise
    } finally {
      this.mainTaskLocks.delete(key)
    }
  }

  /**
   * Materialise the worktree on disk for `task`. Idempotent: if the recorded
   * worktree still exists, fast-path it. If the recorded dir vanished (a UI/web
   * delete that didn't clear the index, a manual `rm`, a crash mid-`deleteTask`),
   * self-heal: prune git's stale registration, drop the dead path, and
   * re-materialise onto the task's OWN branch — committed work recovered, not a
   * permanently-dead task. Returns the worktree path.
   */
  async ensureWorktree(id: TaskId | string): Promise<string> {
    const task = this.requireTask(id)
    if (task.deletion) throw new TaskDeletingError(String(task.id))
    if (task.kind === "main") return repoWorkingDir(task.repo)
    if (task.worktreePath) {
      if (await this.worktrees.pathExists(task.worktreePath)) return task.worktreePath
      // Recorded path is gone: prune git's dangling registration (else `worktree
      // add` on the same path errors), clear the dead pointer, re-materialise.
      await this.worktrees.pruneWorktrees(task.repo)
      await this.store.update(task.id, { worktreePath: "" })
      return this.worktreeCoordinator.ensure({ ...task, worktreePath: "" })
    }
    // Lazy materialise via the coordinator; the short-circuits above read the
    // task index, not the worktree side, so they stay here.
    return this.worktreeCoordinator.ensure(task)
  }

  /**
   * Clear a task's `worktreePath` (keeping its branch) after an out-of-band
   * worktree removal — the next enter re-materialises onto the retained branch
   * instead of spawning into a dead dir. No-op if already unlinked.
   */
  async clearWorktreePath(id: TaskId | string): Promise<void> {
    const task = this.store.get(id)
    if (!task || !task.worktreePath) return
    await this.store.update(task.id, { worktreePath: "" })
    this.worktreeCoordinator.forget(task.id)
  }

  // In-place task-field edits (title / branch / vendor / pinned / archived /
  // status / PR-status / move / reorder) live in the TaskEditor collaborator;
  // these are thin delegators so the public interface is unchanged.

  /** Rename a task. Empty / whitespace-only titles are rejected. */
  async setTitle(id: TaskId | string, title: string): Promise<void> {
    return this.editor.setTitle(id, title)
  }

  /** Rename a task's branch (git branch -m for a materialised worktree). Rejected for `main`. */
  async setBranch(id: TaskId | string, branch: string): Promise<void> {
    return this.editor.setBranch(id, branch)
  }

  /** Change a task's engine vendor. Pure metadata; takes effect on next enter. */
  async setVendor(id: TaskId | string, vendor: VendorId): Promise<void> {
    return this.editor.setVendor(id, vendor)
  }

  /** Toggle / set the `pinned` flag. No-op for `kind: "main"` (always pinned). */
  async setPinned(id: TaskId | string, pinned?: boolean): Promise<void> {
    return this.editor.setPinned(id, pinned)
  }

  /** Move a regular task up/down within its visible ordering partition. */
  async moveTask(id: TaskId | string, delta: -1 | 1): Promise<void> {
    return this.editor.moveTask(id, delta)
  }

  /** Toggle / set the `archived` flag. No-op for `kind: "main"`. */
  async setArchived(id: TaskId | string, archived?: boolean): Promise<void> {
    return this.editor.setArchived(id, archived)
  }

  /** Batch-assign web-board `position` keys (all-or-nothing validation). Refuses main rows. */
  async reorderTasks(moves: ReadonlyArray<{ readonly taskId: string; readonly position: number }>): Promise<void> {
    return this.editor.reorderTasks(moves)
  }

  /** Move a task between status states. Refuses `done` ↔ `error` flip-flops. */
  async setStatus(id: TaskId | string, status: TaskStatus): Promise<void> {
    return this.editor.setStatus(id, status)
  }

  /** Set (or clear, with `null`) a task's PR status — driven by the daemon's collector. */
  async setPRStatus(id: TaskId | string, prStatus: TaskPRStatus | null): Promise<void> {
    return this.editor.setPRStatus(id, prStatus)
  }

  /**
   * Permanently remove a task. Refuses to delete `kind: "main"`
   * tasks (the user removes the repo from saved repos instead).
   *
   * Worktree safety: without `opts.force` a worktree with
   * uncommitted / untracked changes is NOT destroyed — we throw
   * {@link DirtyWorktreeError} so the UI can re-prompt for explicit
   * force confirmation. And if `git worktree remove` itself fails
   * (locked / permission / corrupt git-dir) we throw
   * {@link WorktreeRemoveFailedError} and KEEP the index entry, so the
   * orphaned worktree stays visible + re-deletable instead of becoming
   * invisible on-disk debris. The index entry is dropped only after the
   * worktree is genuinely gone.
   */
  async deleteTask(id: TaskId | string, opts?: { readonly force?: boolean }): Promise<void> {
    await this.deletions.deleteNow(id, opts)
  }

  /** Persist a deletion request after the normal safety checks. */
  async prepareTaskDeletion(id: TaskId | string, opts?: { readonly force?: boolean }): Promise<boolean> {
    return this.deletions.prepare(id, opts)
  }

  /** Transition a queued/resumed deletion to running. */
  async beginTaskDeletion(id: TaskId | string): Promise<boolean> {
    return this.deletions.begin(id)
  }

  /** Execute physical cleanup and retain a visible error on failure. */
  async finishTaskDeletion(id: TaskId | string): Promise<void> {
    return this.deletions.finish(id)
  }

  /** Land a task's branch back into its base repo — executor + cleanup in `land.ts`. */
  async landTask(id: TaskId | string, opts?: LandTaskOpts): Promise<LandResult> {
    const task = this.requireTask(id)
    return landTaskWithCleanup(task, opts ?? {}, {
      worktrees: this.worktrees,
      setArchived: (tid, archived) => this.editor.setArchived(tid, archived),
    })
  }

  /**
   * Forget a saved project: drop it from `savedRepos` (+ any remote `ssh://`
   * connection config) AND remove the synthetic `kind:"main"` sidebar row.
   * Non-destructive — the repo's files, branches, and non-main task worktrees
   * all stay; only the picker entry + project header go away. The inverse of
   * {@link ensureMainTask} and the ONE supported way to remove a main row
   * ({@link deleteTask} refuses them — they project `savedRepos`, not real
   * work). The main row's `worktreePath` is the repo root, so this touches only
   * the index, never `git worktree remove`. Idempotent.
   */
  async forgetProject(repo: string): Promise<void> {
    if (!repo) throw new Error("forgetProject: repo is required")
    // Match by the canonical main-repo key (realpath of the git toplevel, or
    // the verbatim ssh:// key) so a subdir / differently-realpathed input
    // (`/var` vs `/private/var` on macOS) still hits the stored savedRepos
    // entry and the stored main task — the two are written in different forms
    // (caller path vs git output), so a plain string compare misses.
    const key = normalizeMainRepo(repo).key
    for (const saved of getSavedRepos()) {
      if (normalizeMainRepo(saved).key === key) removeSavedRepo(saved)
    }
    for (const task of this.store.list()) {
      if (task.kind !== "main") continue
      if (normalizeMainRepo(task.repo).key !== key) continue
      await this.store.remove(task.id)
      this.worktreeCoordinator.forget(task.id)
    }
  }

  /**
   * Discover git worktrees on `repo` that exist on disk but aren't yet
   * linked to any task — candidates for adoption. Includes
   * worktrees outside the kobe convention root (the user's own
   * `git worktree add`). De-dupes against the task store by canonical
   * path so an already-adopted worktree never reappears.
   */
  async discoverAdoptableWorktrees(repo: string): Promise<readonly AdoptableWorktree[]> {
    if (!repo) throw new Error("discoverAdoptableWorktrees: repo is required")
    return this.worktreeCoordinator.discoverAdoptable(repo)
  }

  /**
   * Adopt an existing git worktree as a new task. The worktree
   * already exists on disk, so we record the task with its real path +
   * branch directly — `ensureWorktree` then short-circuits (non-empty
   * `worktreePath`) and never touches the filesystem. Validates the path
   * is a real worktree of `repo` and isn't already a task. The dedupe lock +
   * validation + main-task provisioning live in the coordinator.
   */
  async adoptWorktree(input: {
    readonly repo: string
    readonly worktreePath: string
    readonly branch?: string
    readonly vendor?: VendorId
    readonly title?: string
    /**
     * What to do when a task already tracks this worktree. `"error"` (default,
     * the user-facing `kobe api adopt` path) throws; `"return"` (the
     * WorktreeCreate hook path) returns the existing task, making sync
     * idempotent — a re-fired hook or a worktree kobe already owns is a no-op.
     */
    readonly ifExists?: "error" | "return"
  }): Promise<Task> {
    if (!input.repo) throw new Error("adoptWorktree: repo is required")
    if (!input.worktreePath) throw new Error("adoptWorktree: worktreePath is required")
    return this.worktreeCoordinator.adopt(input)
  }

  // --- internals ---

  private requireTask(id: TaskId | string): Task {
    const task = this.store.get(id)
    if (!task) throw new TaskNotFoundError(String(id))
    return task
  }
}
