/**
 * Worktree lifecycle side-effects for the {@link Orchestrator}.
 *
 * The Orchestrator owns the task index + reactive snapshot; this collaborator
 * owns everything that actually touches git worktrees on disk — slug
 * allocation, the lazy materialise-on-first-enter dance, adoption of
 * pre-existing worktrees, and the per-task / per-path locks that keep those
 * operations race- and delete-safe. The Orchestrator holds one of these and
 * delegates; its public methods stay thin so the class interface is unchanged.
 *
 * All the load-bearing invariants live here verbatim (moved out of
 * `core.ts`, no behaviour change):
 *
 *   - **Lazy allocation.** `createTask` records intent (empty `worktreePath`);
 *     the directory only materialises when {@link ensure} runs on first enter.
 *   - **Dedupe + delete-safety.** {@link ensure} / {@link adopt} return the
 *     shared in-flight promise so a concurrent caller reads the created path
 *     rather than re-reading the store (which would throw if a delete landed
 *     in that window).
 *   - **Self-cleaning rollback.** {@link createWorktree} commits the slug ONLY
 *     after the store write succeeds; any partial failure removes the
 *     just-created worktree and frees the slug so nothing is orphaned.
 */

import { basename } from "node:path"
import type { Task, TaskId, VendorId } from "../types/task.ts"
import { DEFAULT_TASK_VENDOR } from "../types/task.ts"
import type { AdoptableWorktree, WorktreeInfo } from "../types/worktree.ts"
import type { TaskIndexStore } from "./index/store.ts"
import { autoBranch } from "./title.ts"
import type { GitWorktreeManager } from "./worktree/manager.ts"
import { SlugAllocator } from "./worktree/slug-allocator.ts"

/** Placeholder title reused for adopted worktrees with an empty derived name. */
const PLACEHOLDER_TASK_TITLE = "(new task)"

/** Resolve a canonical path — injected by the Orchestrator so both sides dedupe identically. */
type CanonPath = (p: string) => string

/**
 * Ensure the repo's `kind:"main"` project row exists before an adopted task is
 * created — injected so the main-task logic stays in the Orchestrator while the
 * call keeps firing at its original point INSIDE the adopt lock.
 */
type EnsureProject = (repo: string) => Promise<unknown>

export interface AdoptWorktreeInput {
  readonly repo: string
  readonly worktreePath: string
  readonly branch?: string
  readonly vendor?: VendorId
  readonly title?: string
  readonly ifExists?: "error" | "return"
}

/**
 * Owns the git-worktree side of the task lifecycle. One per {@link Orchestrator}.
 */
export class WorktreeCoordinator {
  private readonly store: TaskIndexStore
  private readonly worktrees: GitWorktreeManager
  private readonly canonPath: CanonPath
  private readonly ensureProject: EnsureProject
  private readonly slugs: SlugAllocator
  /**
   * Per-task lock so concurrent `ensure` calls don't race. The resolved value
   * is the created worktree path, so a waiter reads the result from the shared
   * promise instead of re-fetching the task after the lock — which would throw
   * {@link TaskNotFoundError} if a concurrent delete landed in that window even
   * though the worktree was created fine.
   */
  private readonly worktreeLocks = new Map<TaskId, Promise<string>>()
  /** In-flight `adopt` per canonical worktree path — dedupes concurrent adopts. */
  private readonly adoptLocks = new Map<string, Promise<Task>>()
  /** Optional base-ref per task — consumed once by `ensure`. */
  private readonly pendingBaseRefs = new Map<TaskId, string>()

  constructor(
    store: TaskIndexStore,
    worktrees: GitWorktreeManager,
    canonPath: CanonPath,
    ensureProject: EnsureProject,
  ) {
    this.store = store
    this.worktrees = worktrees
    this.canonPath = canonPath
    this.ensureProject = ensureProject
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
  }

  /** Record a one-shot base ref for the next {@link ensure} of `id`. */
  setPendingBaseRef(id: TaskId, baseRef: string): void {
    this.pendingBaseRefs.set(id, baseRef)
  }

  /** Drop a task's pending base-ref + in-flight worktree lock (on delete / forget). */
  forget(id: TaskId): void {
    this.pendingBaseRefs.delete(id)
    this.worktreeLocks.delete(id)
  }

  /**
   * Materialise the worktree on disk for `task` (already known to be a
   * lazily-allocated `kind:"task"` with an empty `worktreePath` — the
   * `main` / already-materialised short-circuits stay in the Orchestrator).
   * Idempotent + delete-safe via the per-task lock. Returns the created path.
   */
  async ensure(task: Task): Promise<string> {
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

  /**
   * Discover git worktrees on `repo` that exist on disk but aren't yet
   * linked to any task — candidates for adoption. Includes
   * worktrees outside the kobe convention root (the user's own
   * `git worktree add`). De-dupes against the task store by canonical
   * path so an already-adopted worktree never reappears.
   */
  async discoverAdoptable(repo: string): Promise<readonly AdoptableWorktree[]> {
    const all = await this.worktrees.listAll(repo)
    const linked = new Set(
      this.store
        .list()
        .filter((t) => t.worktreePath)
        .map((t) => this.canonPath(t.worktreePath)),
    )
    return all.filter((wt) => !linked.has(this.canonPath(wt.path)))
  }

  /**
   * Adopt an existing git worktree as a new task. Serializes concurrent adopts
   * of the SAME path via {@link adoptLocks} so two WorktreeCreate hooks firing
   * for one path can't both pass the "already a task?" check and create
   * duplicate tasks — the second caller awaits the first's result. The caller
   * (Orchestrator.adoptWorktree) has already validated the required inputs; the
   * project's main task is ensured here (inside the lock) via `ensureProject`.
   */
  async adopt(input: AdoptWorktreeInput): Promise<Task> {
    const target = this.canonPath(input.worktreePath)
    const inflight = this.adoptLocks.get(target)
    if (inflight) return inflight
    const work = this.adoptLocked(input, target)
    this.adoptLocks.set(target, work)
    try {
      return await work
    } finally {
      this.adoptLocks.delete(target)
    }
  }

  private async adoptLocked(input: AdoptWorktreeInput, target: string): Promise<Task> {
    const existing = this.store.list().find((t) => t.worktreePath && this.canonPath(t.worktreePath) === target)
    if (existing) {
      if (input.ifExists === "return") return existing
      throw new Error(`adoptWorktree: ${input.worktreePath} is already adopted as a task`)
    }
    const candidates = await this.worktrees.listAll(input.repo)
    const match = candidates.find((wt) => this.canonPath(wt.path) === target)
    if (!match) {
      throw new Error(
        `adoptWorktree: ${input.worktreePath} is not an adoptable git worktree of ${input.repo} (unknown, detached, or the main checkout)`,
      )
    }
    const branch = input.branch?.trim() || match.branch
    const title = (input.title ?? basename(match.path)).trim() || PLACEHOLDER_TASK_TITLE
    // Same guarantee as createTask: an adopted task brings its project's
    // main task (= the sidebar PROJECTS row) into existence with it.
    await this.ensureProject(input.repo)
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
}
