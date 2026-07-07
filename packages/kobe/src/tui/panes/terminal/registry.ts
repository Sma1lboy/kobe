/**
 * `PtyRegistry` — one PTY per task, kept alive while the task is in
 * progress, released when the task is archived.
 *
 * The Stream J brief locks in the "one pty per task" rule (see
 * `docs/PLAN.md` §J Resolved Decision). The pane mounts and unmounts
 * per render (every time the user switches the active task or remounts
 * the layout), but the underlying shell shouldn't restart on every
 * mount — that would lose scrollback and any in-flight commands. The
 * registry decouples pane lifecycle (per-render) from shell lifecycle
 * (per-task).
 *
 * Contract (mirrored in `Terminal.tsx`):
 *
 *   - `acquire(taskId, cwd)` returns the existing `TaskPty` for the
 *     task, or creates a new one. Subsequent `acquire`s with the same
 *     id return the same instance.
 *   - `release(taskId)` kills the PTY and forgets it. Called when the
 *     orchestrator archives the task.
 *   - `releaseAll()` kills every registered PTY. Called on app
 *     teardown to avoid leaking shell processes.
 *
 * What the registry deliberately does NOT do:
 *   - It does not subscribe to task status changes. The orchestrator
 *     (Stream E) is responsible for calling `release()` when a task
 *     transitions to `archived` / `done` / etc. The registry is a
 *     dumb container.
 *   - It does not cap concurrency. PLAN.md §4 caps simultaneous
 *     *running* tasks at 4, but a paused-but-in-progress task may
 *     still hold a live PTY. If we hit memory pressure from too many
 *     idle shells we'll add a TTL / LRU eviction layer here.
 *
 * Concurrency: every method is synchronous and JS is single-threaded,
 * so there's no race within a single registry. Two registries pointing
 * at the same task id return the same in-process shell handle. The
 * Solid component creates exactly one registry per app instance; tests
 * stand up disposable registries inside a single `describe` block.
 */

import { type TaskPty, type TaskPtyOpts, createTaskPty } from "./pty"

export type AcquireOpts = Omit<TaskPtyOpts, "taskId" | "cwd">

/**
 * Factory for the underlying `TaskPty`. Defaults to `createTaskPty`
 * but is injectable so tests can swap in a `MockTaskPty` without
 * touching `process.env`.
 */
export type PtyFactory = (opts: TaskPtyOpts) => TaskPty

export class PtyRegistry {
  private readonly map = new Map<string, TaskPty>()
  private readonly factory: PtyFactory

  constructor(factory: PtyFactory = createTaskPty) {
    this.factory = factory
  }

  /**
   * Return the existing PTY for `taskId`, or spawn a new one bound to
   * `cwd`. The `cwd` is only used on first acquisition; subsequent
   * acquires return the existing instance regardless of `cwd`. The
   * Solid component is expected to `release()` and re-`acquire()` if
   * the task's worktree path actually changes — but in our data model
   * the worktree path is immutable for the lifetime of the task, so
   * that's a defensive contract not a runtime concern.
   */
  acquire(taskId: string, cwd: string, opts: AcquireOpts = {}): TaskPty {
    const existing = this.map.get(taskId)
    if (existing && !existing.killed) return existing
    // If we had a stale entry (killed externally), drop it before
    // creating a fresh one.
    if (existing) this.map.delete(taskId)

    const pty = this.factory({ taskId, cwd, ...opts })
    this.map.set(taskId, pty)
    return pty
  }

  /** Look up an existing PTY without creating one. Returns null if absent. */
  get(taskId: string): TaskPty | null {
    const pty = this.map.get(taskId)
    if (!pty) return null
    if (pty.killed) {
      this.map.delete(taskId)
      return null
    }
    return pty
  }

  /** Whether a live PTY exists for this task id. */
  has(taskId: string): boolean {
    return this.get(taskId) !== null
  }

  /**
   * Kill the PTY for `taskId` and forget it. No-op if absent. The
   * orchestrator calls this when the task is archived.
   */
  release(taskId: string): void {
    const pty = this.map.get(taskId)
    this.map.delete(taskId)
    if (!pty) return
    try {
      pty.kill()
    } catch {
      // Already dead. Idempotent — see `TaskPty.kill()` contract.
    }
  }

  /**
   * Kill and forget every PTY whose id matches `predicate` — the
   * task-scoped teardown for tab-keyed PTYs (`taskId::tabId`, issue
   * #16): archiving a task must end every engine session it owns.
   */
  releaseWhere(predicate: (id: string) => boolean): void {
    const ids = Array.from(this.map.keys()).filter(predicate)
    for (const id of ids) this.release(id)
  }

  /**
   * Kill every PTY and forget them all. Called on TUI teardown to
   * leave no orphan shell processes.
   */
  releaseAll(): void {
    const ids = Array.from(this.map.keys())
    for (const id of ids) this.release(id)
  }

  /**
   * Detach every PTY and forget them all — the app-exit counterpart of
   * `releaseAll()` for persistent backends: a daemon-hosted session keeps
   * RUNNING in the background and reattaches on the next boot. Backends
   * without `detach()` (local child — nothing to persist) are killed,
   * exactly as before.
   */
  detachAll(): void {
    const ptys = Array.from(this.map.values())
    this.map.clear()
    for (const pty of ptys) {
      try {
        if (pty.detach) pty.detach()
        else pty.kill()
      } catch {
        /* already dead */
      }
    }
  }

  /**
   * Kill the PTY for `taskId` (if any) and immediately spawn a fresh
   * one with the same `cwd` / `opts`. Returns the new instance.
   *
   * The use cases are "shell is stuck" / "binary spew corrupted the
   * grid" / "I want a clean slate without restarting kobe." The
   * user-visible effect is: scrollback wiped, fresh prompt at the
   * worktree path, all in-flight processes (vim, htop, paused jobs)
   * killed.
   *
   * Implemented in terms of release + acquire so the cleanup path is
   * shared with archive teardown — no risk of leaking a PTY whose
   * old listeners weren't unwired.
   */
  reset(taskId: string, cwd: string, opts: AcquireOpts = {}): TaskPty {
    this.release(taskId)
    return this.acquire(taskId, cwd, opts)
  }

  /** Tests / debug: how many live PTYs are tracked. */
  get size(): number {
    return this.map.size
  }
}

/**
 * Default registry shared by every `<Terminal />` instance in the app.
 * Stream E will reach into it to call `release(taskId)` when a task is
 * archived; until then the registry just keeps PTYs alive.
 *
 * Tests pass their own registry via `props.registry`.
 */
let defaultRegistry: PtyRegistry | null = null

export function getDefaultPtyRegistry(): PtyRegistry {
  if (!defaultRegistry) defaultRegistry = new PtyRegistry()
  return defaultRegistry
}

/**
 * Reset the module-level registry. Tests use this between cases so a
 * leftover registry doesn't leak shell processes across tests.
 */
export function _resetDefaultPtyRegistry(): void {
  if (defaultRegistry) defaultRegistry.releaseAll()
  defaultRegistry = null
}
