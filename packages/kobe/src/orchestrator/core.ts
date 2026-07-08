/**
 * Orchestrator (v0.6).
 *
 * What it owns: task lifecycle + worktree allocation + the reactive
 * snapshot the TUI subscribes to. That's all.
 *
 * What it lost vs v0.5:
 *   - The whole engine port (`spawn` / `resume` / `stream`). Engines
 *     (claude / codex) now run inside tmux panes, owned by tmux —
 *     kobe never drives them as subprocesses anymore.
 *   - `pumpEvents` / event-bus / per-tab subscribers / user-input
 *     broker. No live event stream from inside an engine to surface.
 *   - Orchestrator-owned ChatTab CRUD. ChatTabs are tmux windows inside a
 *     task's tmux Session now, so tmux owns their lifecycle/persistence.
 *   - Create-PR / merge / refresh-PR-status. A follow-up will re-introduce
 *     create-PR as a `tmux send-keys` injection from the Ops pane.
 *
 * What it gained: `ensureWorktree(id)` — the path task-entry surfaces
 * (`direct.ts`, the Tasks pane, `kobe api`) call before
 * `tmux new-session` to make sure the task's worktree exists on disk. (Worktree allocation is still lazy: `createTask`
 * records the intent; the directory only materialises when the user
 * actually enters the task.)
 */

import { realpathSync } from "node:fs"
import { basename, resolve } from "node:path"
import type { Accessor } from "solid-js"
import { createSignal } from "solid-js"
import { samePrStatus } from "../monitor/pr-status.ts"
import { readLastActiveTaskId, writeLastActiveTaskId } from "../state/last-active.ts"
import {
  getRemoteRepoConfig,
  getSavedRepos,
  isRemoteRepoKey,
  removeSavedRepo,
  resolveRepoRoot,
} from "../state/repos.ts"
import { resolvePreferredVendor } from "../state/vendor-prefs.ts"
import type { Task, TaskId, TaskPRStatus, TaskStatus, VendorId } from "../types/task.ts"
import { DEFAULT_TASK_VENDOR, toTaskId } from "../types/task.ts"
import type { AdoptableWorktree, WorktreeInfo } from "../types/worktree.ts"
import {
  CannotDeleteMainTaskError,
  DirtyWorktreeError,
  IllegalTransitionError,
  TaskNotFoundError,
  WorktreeRemoveFailedError,
} from "./errors.ts"
import type { TaskIndexStore, TaskIndexUnsubscribe } from "./index/store.ts"
import { autoBranch } from "./title.ts"
import type { GitWorktreeManager } from "./worktree/manager.ts"
import { worktreePathFor } from "./worktree/paths.ts"
import { SlugAllocator } from "./worktree/slug-allocator.ts"

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

/**
 * Placeholder title for tasks created before the user picks one.
 */
export const PLACEHOLDER_TASK_TITLE = "(new task)"

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
  private readonly slugs: SlugAllocator
  private readonly tasksAcc: Accessor<Task[]>
  private readonly setTasks: (next: Task[]) => void
  private readonly activeTaskAcc: Accessor<string | null>
  private readonly setActiveTaskSig: (next: string | null) => void
  private readonly unsubscribeStore: TaskIndexUnsubscribe
  /**
   * Per-task lock so concurrent `ensureWorktree` calls don't race. The
   * resolved value is the created worktree path, so a waiter reads the result
   * from the shared promise instead of re-fetching the task after the lock —
   * which would throw {@link TaskNotFoundError} if a concurrent delete landed
   * in that window even though the worktree was created fine.
   */
  private readonly worktreeLocks = new Map<TaskId, Promise<string>>()
  /** Lock for `ensureMainTask` so concurrent calls don't double-create. */
  private readonly mainTaskLocks = new Map<string, Promise<Task>>()

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store
    this.worktrees = deps.worktrees
    this.slugs = new SlugAllocator((repo) =>
      this.store
        .list()
        .filter((t) => t.repo === repo && t.kind !== "main")
        .map((t) => {
          const slug = t.worktreePath.match(/([^/\\]+)[/\\]*$/)?.[1] ?? ""
          return slug
        })
        .filter((s) => s.length > 0),
    )
    const [tasks, setTasks] = createSignal<Task[]>(this.store.list())
    this.tasksAcc = tasks
    this.setTasks = (next) => setTasks(() => next)
    // Seed focus from the persisted `lastActive` record (state/last-active
    // .ts) so a daemon restart or fresh TUI opens on the last-focused task
    // instead of "first in the list". Dropped silently when the task is
    // gone (deleted since) — the UI's own fallback picks a survivor.
    const persistedFocus = readLastActiveTaskId()
    const [activeTask, setActiveTask] = createSignal<string | null>(
      persistedFocus && this.store.get(persistedFocus) ? persistedFocus : null,
    )
    this.activeTaskAcc = activeTask
    this.setActiveTaskSig = (next) => setActiveTask(() => next)
    this.unsubscribeStore = this.store.subscribe((snapshot) => {
      this.setTasks(snapshot.slice())
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
  activeTaskSignal(): Accessor<string | null> {
    return this.activeTaskAcc
  }

  /** Set the active-task focus and touch recency for task-list sorting. */
  async setActiveTask(id: TaskId | string | null): Promise<void> {
    const next = id === null ? null : String(id)
    this.setActiveTaskSig(next)
    if (next && this.store.get(next)) {
      // Global last-writer-wins focus record — see state/last-active.ts.
      writeLastActiveTaskId(next)
      await this.store.update(next, {})
    }
  }

  /** Solid signal of the current task list. */
  tasksSignal(): Accessor<Task[]> {
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
    if (input.baseRef) this.pendingBaseRefs.set(task.id, input.baseRef)
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
   * Materialise the worktree on disk for `task`. Idempotent: if the
   * worktree already exists, this is a fast path that just verifies
   * the recorded path. Task-entry surfaces call this before
   * `tmux new-session` so the engine's `cwd` is real.
   *
   * Returns the worktree path (same as `task.worktreePath` on success).
   */
  async ensureWorktree(id: TaskId | string): Promise<string> {
    const task = this.requireTask(id)
    if (task.kind === "main") return repoWorkingDir(task.repo)
    if (task.worktreePath) return task.worktreePath
    // A concurrent caller already in flight: await ITS result (the created
    // path) rather than re-reading the store afterwards. Returning the shared
    // promise both dedupes the work and is delete-safe — see worktreeLocks.
    const inflight = this.worktreeLocks.get(task.id)
    if (inflight) return inflight
    const work = this.createWorktree(task)
    this.worktreeLocks.set(task.id, work)
    try {
      return await work
    } finally {
      this.worktreeLocks.delete(task.id)
    }
  }

  /**
   * Allocate a slug, create the worktree, persist the path/branch. Self-cleaning
   * and safe to retry: every partial-failure path rolls back so we never leave
   * an orphan (a worktree on disk + a committed slug + a task whose
   * `worktreePath` stayed empty, which would force a manual `rm` on the next
   * attempt).
   *
   * Ordering is load-bearing: the slug is committed ONLY after `store.update`
   * succeeds. Until then any failure — git error, or the task being deleted out
   * from under us so the write throws — removes the just-created worktree and
   * frees the slug. Returns the created path directly (not a store re-read) so
   * a delete that lands the instant after creation can't turn a success into a
   * spurious {@link TaskNotFoundError}.
   */
  private async createWorktree(task: Task): Promise<string> {
    const slug = await this.slugs.allocate(task.repo)
    const branch = task.branch || autoBranch(task.title, task.id)
    const baseRef = this.pendingBaseRefs.get(task.id)
    let info: WorktreeInfo
    try {
      info = await this.worktrees.createForTask({ repo: task.repo, slug, branch, baseRef })
    } catch (err) {
      // Nothing persisted yet — just free the slug for the next attempt.
      this.slugs.cancel(task.repo, slug)
      throw err
    }
    // The worktree now exists on disk. Persist its path BEFORE committing the
    // slug; if the write fails (or the task was deleted concurrently, so the
    // delete flow saw an empty `worktreePath` and skipped cleanup) we must roll
    // the worktree back ourselves, or it becomes invisible on-disk debris.
    try {
      await this.store.update(task.id, { worktreePath: info.path, branch })
    } catch (err) {
      await this.rollbackWorktree(info.path)
      this.slugs.cancel(task.repo, slug)
      throw err
    }
    this.slugs.commit(task.repo, slug)
    this.pendingBaseRefs.delete(task.id)
    return info.path
  }

  /**
   * Best-effort removal of a worktree we just created but couldn't persist.
   * `force` because it's a brand-new checkout with no user work to protect, and
   * a clean rollback matters more than the dirty-guard here. A failure is
   * logged, not thrown — the caller already has the real (persist) error and we
   * don't want to mask it.
   */
  private async rollbackWorktree(worktreePath: string): Promise<void> {
    try {
      await this.worktrees.remove(worktreePath, { force: true })
    } catch (err) {
      console.error(`[kobe] ensureWorktree rollback failed for ${worktreePath}:`, err)
    }
  }

  /** Rename a task. Empty / whitespace-only titles are rejected. */
  async setTitle(id: TaskId | string, title: string): Promise<void> {
    const trimmed = title.trim()
    if (!trimmed) throw new Error("setTitle: title is required (empty or whitespace-only rejected)")
    const task = this.requireTask(id)
    if (task.title === trimmed) return
    await this.store.update(task.id, { title: trimmed })
    await this.followBranchToTitle(task, trimmed)
  }

  /**
   * Keep a materialised task's branch in lockstep with its title WHILE the
   * branch is still the placeholder-derived default (`kobe/new-task-<id>`).
   * This is what lets a task auto-named from its first prompt also pick up a
   * meaningful branch instead of staying `kobe/new-task-…`. It fires at most
   * once: after the first rename the branch no longer matches the placeholder
   * derivation, so a later title change (or a manual `setBranch`) is never
   * clobbered. Skipped for `main` (no branch) and for not-yet-materialised
   * tasks (their branch is derived fresh from the title in {@link ensureWorktree},
   * so no rename is needed). Best-effort: a git rename failure is logged, not
   * thrown — the title update already committed and must stand.
   */
  private async followBranchToTitle(taskBefore: Task, newTitle: string): Promise<void> {
    if (taskBefore.kind === "main" || !taskBefore.worktreePath) return
    if (taskBefore.branch !== autoBranch(PLACEHOLDER_TASK_TITLE, taskBefore.id)) return
    const nextBranch = autoBranch(newTitle, taskBefore.id)
    if (nextBranch === taskBefore.branch) return
    try {
      await this.setBranch(taskBefore.id, nextBranch)
    } catch (err) {
      console.error(`[kobe] follow-branch-to-title failed for ${taskBefore.id}:`, err)
    }
  }

  /**
   * Rename a task's branch. For a materialised worktree this renames
   * the real git branch (`git branch -m`, which also moves HEAD on the
   * checked-out worktree so a running session keeps streaming); for a
   * not-yet-materialised task it just records the name, which
   * {@link ensureWorktree} then uses instead of the title-derived
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
    if (task.branch === trimmed) return
    if (task.worktreePath) {
      await this.worktrees.renameBranch(task.worktreePath, task.branch, trimmed)
    }
    await this.store.update(task.id, { branch: trimmed })
  }

  /**
   * Change a task's engine vendor. Pure metadata — no git / tmux side
   * effects here. The change takes effect on the task's next enter:
   * `ensureSession` rebuilds a session whose `@kobe_vendor` tag no
   * longer matches, so the new tmux pane launches the new engine.
   */
  async setVendor(id: TaskId | string, vendor: VendorId): Promise<void> {
    const task = this.requireTask(id)
    if (task.vendor === vendor) return
    await this.store.update(task.id, { vendor })
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
   * Move a regular task up/down within its visible ordering partition.
   * Main project rows stay sorted by repo name and are not manually moved.
   */
  async moveTask(id: TaskId | string, delta: -1 | 1): Promise<void> {
    const task = this.requireTask(id)
    if (task.kind === "main") return
    const groupIds = this.store
      .list()
      .filter(
        (t) =>
          (t.kind ?? "task") !== "main" &&
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
    const task = this.store.get(id)
    if (!task) return
    if (task.kind === "main") {
      throw new CannotDeleteMainTaskError()
    }
    const force = opts?.force === true
    if (task.worktreePath) {
      if (!force) {
        let dirty = false
        try {
          dirty = await this.worktrees.isDirty(task.worktreePath)
        } catch {
          // Can't determine dirtiness (e.g. the path is already gone) —
          // treat as clean and let remove() handle the missing-dir case.
        }
        if (dirty) throw new DirtyWorktreeError(task.id)
      }
      try {
        await this.worktrees.remove(task.worktreePath, { force })
      } catch (err) {
        // Keep the index entry — see method doc. Surfacing instead of
        // the old console.warn-and-continue means a failed cleanup no
        // longer silently orphans the worktree.
        throw new WorktreeRemoveFailedError(task.id, err)
      }
    }
    await this.store.remove(task.id)
    this.pendingBaseRefs.delete(task.id)
    this.worktreeLocks.delete(task.id)
  }

  /**
   * Forget a saved project: drop it from `savedRepos` (and, for a remote
   * `ssh://` project, its stored connection config) AND remove the synthetic
   * `kind: "main"` row that projects it into the sidebar. Non-destructive —
   * the repo's files, branches, and its non-main task worktrees all stay on
   * disk; only the picker entry + the project header row go away.
   *
   * This is the inverse of {@link ensureMainTask} and the one supported way to
   * remove a main row: {@link deleteTask} deliberately refuses main rows
   * (throws {@link CannotDeleteMainTaskError}) because they are a projection
   * of `savedRepos`, not real work. Without this, un-saving a repo left an
   * orphaned main task in the index — the row stayed, un-deletable, and a
   * garbage `kobe add` entry (e.g. `kobe add ,`) could never be cleared.
   *
   * The main task's `worktreePath` is the repo root itself (see
   * {@link ensureMainTask}), so we remove ONLY the index entry — never a
   * `git worktree remove`. Idempotent: forgetting an already-forgotten /
   * never-saved repo just no-ops.
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
      this.pendingBaseRefs.delete(task.id)
      this.worktreeLocks.delete(task.id)
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
    const all = await this.worktrees.listAll(repo)
    const linked = new Set(
      this.store
        .list()
        .filter((t) => t.worktreePath)
        .map((t) => canonPath(t.worktreePath)),
    )
    return all.filter((wt) => !linked.has(canonPath(wt.path)))
  }

  /**
   * Adopt an existing git worktree as a new task. The worktree
   * already exists on disk, so we record the task with its real path +
   * branch directly — `ensureWorktree` then short-circuits (non-empty
   * `worktreePath`) and never touches the filesystem. Validates the path
   * is a real worktree of `repo` and isn't already a task.
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
    const target = canonPath(input.worktreePath)
    // Serialize concurrent adopts of the SAME worktree path. Without this, two
    // WorktreeCreate hooks firing for one path could both pass the "already a
    // task?" check (it awaits `listAll` before `create`) and create duplicate
    // tasks. The lock dedupes: the second caller awaits the first's result.
    const inflight = this.adoptLocks.get(target)
    if (inflight) return inflight
    const work = this.adoptWorktreeLocked(input, target)
    this.adoptLocks.set(target, work)
    try {
      return await work
    } finally {
      this.adoptLocks.delete(target)
    }
  }

  private async adoptWorktreeLocked(
    input: {
      readonly repo: string
      readonly worktreePath: string
      readonly branch?: string
      readonly vendor?: VendorId
      readonly title?: string
      readonly ifExists?: "error" | "return"
    },
    target: string,
  ): Promise<Task> {
    const existing = this.store.list().find((t) => t.worktreePath && canonPath(t.worktreePath) === target)
    if (existing) {
      if (input.ifExists === "return") return existing
      throw new Error(`adoptWorktree: ${input.worktreePath} is already adopted as a task`)
    }
    const candidates = await this.worktrees.listAll(input.repo)
    const match = candidates.find((wt) => canonPath(wt.path) === target)
    if (!match) {
      throw new Error(
        `adoptWorktree: ${input.worktreePath} is not an adoptable git worktree of ${input.repo} (unknown, detached, or the main checkout)`,
      )
    }
    const branch = input.branch?.trim() || match.branch
    const title = (input.title ?? basename(match.path)).trim() || PLACEHOLDER_TASK_TITLE
    return this.store.create({
      repo: input.repo,
      title,
      branch,
      worktreePath: match.path,
      status: "backlog",
      kind: "task",
      vendor: input.vendor ?? DEFAULT_TASK_VENDOR,
    })
  }

  // --- internals ---

  /** Optional base-ref per task — consumed once by `ensureWorktree`. */
  private readonly pendingBaseRefs = new Map<TaskId, string>()

  /** In-flight `adoptWorktree` per canonical worktree path — dedupes concurrent adopts. */
  private readonly adoptLocks = new Map<string, Promise<Task>>()

  private requireTask(id: TaskId | string): Task {
    const task = this.store.get(id)
    if (!task) throw new TaskNotFoundError(String(id))
    return task
  }
}

function titleFromRepo(repo: string): string {
  const segs = repo.split(/[/\\]/).filter(Boolean)
  return segs.length > 0 ? (segs[segs.length - 1] ?? repo) : repo
}

function normalizeMainRepo(repo: string): { repo: string; key: string } {
  const normalized = resolveRepoRoot(repo)
  return {
    repo: normalized,
    key: isRemoteRepoKey(normalized) ? normalized : canonPath(normalized),
  }
}

/**
 * Resolve symlinks so two strings naming the same node compare equal
 * (macOS `/var` → `/private/var`). Falls back to `resolve` when the path
 * doesn't exist. Used to de-dupe discovered worktrees against task paths,
 * which may be stored in different (caller vs git) forms.
 */
function canonPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

// Avoid an unused-import warning while keeping toTaskId reachable for
// callers that need to brand a raw string id.
void toTaskId
