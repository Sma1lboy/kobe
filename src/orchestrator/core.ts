/**
 * Orchestrator core — Wave 2 Stream E.
 *
 * The glue layer. Owns the task lifecycle and dispatches to the three
 * Wave 1 modules: {@link AIEngine} (Stream A), `GitWorktreeManager`
 * (Stream B), and `TaskIndexStore` (Stream C). The whole upstream stack
 * is injected so behavior tests can swap in `FakeAIEngine` and a tmpdir
 * store without touching network or git auth.
 *
 * Design notes:
 *
 *   - **Status state machine.** Transitions are enforced explicitly here,
 *     not implicitly through `update({ status })`. `runTask` only fires
 *     when the task is `backlog` (or already done/error and being
 *     re-run); `pauseTask` only fires when in_progress; `archiveTask`
 *     accepts `done` or `canceled` and is allowed from any state. Bad
 *     transitions throw `IllegalTransitionError` so callers can branch.
 *
 *   - **Concurrency cap (4).** Per DESIGN §11.5 (resolved). When a 5th
 *     `runTask` is requested we reject with a typed `ConcurrencyCapError`
 *     rather than silently queueing — the UI surfaces the error and the
 *     user can pause something. Queueing belongs in a later stream.
 *
 *   - **Resume cwd back-channel.** `AIEngine.resume()` does not take a
 *     cwd — Stream A reads it from `opts.env.KOBE_RESUME_CWD` (else
 *     falls back to `process.cwd()`). The orchestrator runs in kobe's
 *     binary cwd, NOT the task's worktree, so we must always pass
 *     `KOBE_RESUME_CWD = task.worktreePath` when resuming. This is
 *     load-bearing and tested below.
 *
 *   - **Per-task event bus.** Events from `engine.stream(handle)` flow
 *     into a small in-memory bus (`Map<TaskId, Set<cb>>`). The chat
 *     pane subscribes per active task; on task switch the previous
 *     subscription is torn down. Subscribers are weak (we hold the cb,
 *     not the task), so a leaked subscription leaks one closure, not
 *     a worktree.
 *
 *   - **Solid integration.** `tasksSignal()` returns a Solid `Accessor`
 *     so `<Sidebar tasks={orch.tasksSignal()} />` works directly.
 *     Internally we keep a `createSignal<Task[]>` and rewrite it after
 *     every store mutation. The store is the source of truth; the
 *     signal is a memoized projection of it.
 *
 * What this file deliberately does NOT do:
 *
 *   - Persist event history (Claude Code's JSONL is the source of truth;
 *     `engine.readHistory(sessionId)` retrieves it).
 *   - Manage worktree teardown on archive (DESIGN §2.4 says we leave the
 *     worktree until the user explicitly removes it; we just stop the
 *     engine).
 *   - Branch lifecycle (we never delete branches).
 */

import { type Accessor, createSignal } from "solid-js"
import type { AIEngine, EngineEvent, SessionHandle } from "../types/engine.ts"
import type { Task, TaskId, TaskStatus } from "../types/task.ts"
import type { TaskIndexStore } from "./index/store.ts"
import type { GitWorktreeManager } from "./worktree/manager.ts"

/** DI surface for the orchestrator. Tests pass test doubles here. */
export interface OrchestratorDeps {
  readonly engine: AIEngine
  readonly store: TaskIndexStore
  readonly worktrees: GitWorktreeManager
}

/** Maximum simultaneous `in_progress` tasks. From DESIGN §11.5. */
export const CONCURRENCY_CAP = 4

/** Thrown when a state-machine transition is illegal. */
export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
    public readonly taskId: string,
  ) {
    super(`illegal transition for task ${taskId}: ${from} -> ${to}`)
    this.name = "IllegalTransitionError"
  }
}

/** Thrown when we'd exceed {@link CONCURRENCY_CAP}. */
export class ConcurrencyCapError extends Error {
  constructor() {
    super(`concurrency cap reached: ${CONCURRENCY_CAP} tasks running`)
    this.name = "ConcurrencyCapError"
  }
}

/** Thrown when a task id cannot be resolved. */
export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`task not found: ${taskId}`)
    this.name = "TaskNotFoundError"
  }
}

/** Input to {@link Orchestrator.createTask}. */
export interface CreateTaskInput {
  readonly repo: string
  readonly title: string
  /**
   * The user's first prompt. Stored on the task only as part of the
   * `runTask` call (the index doesn't persist prompts — Claude Code
   * does, in its own JSONL). Required for symmetry with future API
   * shapes; today it's not used until `runTask` actually fires.
   */
  readonly prompt: string
  /**
   * Branch override. When omitted, we generate
   * `kobe/<title-slug>-<ulid-suffix-4>` so two same-titled tasks
   * never collide.
   */
  readonly branch?: string
}

/** Subscription teardown for {@link Orchestrator.subscribeEvents}. */
export type Unsubscribe = () => void

/**
 * Owner of the task lifecycle.
 *
 * The orchestrator is the only thing that touches the worktree manager,
 * the engine, and the task index together. UI consumers go through this
 * surface; they don't reach past it.
 */
export class Orchestrator {
  private readonly engine: AIEngine
  private readonly store: TaskIndexStore
  private readonly worktrees: GitWorktreeManager
  private readonly handles = new Map<TaskId, SessionHandle>()
  private readonly subscribers = new Map<TaskId, Set<(ev: EngineEvent) => void>>()
  /** Background pump promises — kept so tests can `await` settle. */
  private readonly pumps = new Map<TaskId, Promise<void>>()

  private readonly tasksAcc: Accessor<Task[]>
  private readonly setTasks: (next: Task[]) => void

  constructor(deps: OrchestratorDeps) {
    this.engine = deps.engine
    this.store = deps.store
    this.worktrees = deps.worktrees
    const [tasks, setTasks] = createSignal<Task[]>(this.store.list())
    this.tasksAcc = tasks
    // Solid's `setSignal` accepts either a value or an updater; we
    // narrow to "always pass a fresh array" so the signal change is
    // detected by reference (Solid uses Object.is by default).
    this.setTasks = (next) => setTasks(() => next)
  }

  /** Solid `Accessor` that yields the current task list. */
  tasksSignal(): Accessor<Task[]> {
    return this.tasksAcc
  }

  /** Snapshot of the current task list. Defensive copy. */
  listTasks(): Task[] {
    return this.store.list()
  }

  getTask(id: TaskId | string): Task | undefined {
    return this.store.get(id)
  }

  /**
   * Create a new task. Allocates the worktree on disk, persists the
   * task in `backlog` status, and returns the new record. Does NOT
   * start the engine — that's `runTask`'s job.
   *
   * Idempotency: not idempotent. Two calls with the same title produce
   * two distinct tasks (the ulid id and the branch suffix differ). If
   * a caller wants idempotent create-or-get semantics they layer it on
   * top.
   */
  async createTask(input: CreateTaskInput): Promise<Task> {
    if (!input.repo) throw new Error("createTask: repo is required")
    if (!input.title) throw new Error("createTask: title is required")

    // Persist with a placeholder branch so we have an id to compute
    // paths from. We then create the worktree, then patch the branch
    // back onto the record. Two-phase to keep a single ulid id flowing
    // through both the worktree path and the persisted record.
    const placeholder = await this.store.create({
      title: input.title,
      repo: input.repo,
      branch: "", // patched below
      worktreePath: "", // patched below
      sessionId: null,
      status: "backlog",
    })

    const branch = input.branch ?? autoBranch(input.title, placeholder.id)

    let info: { path: string; branch: string }
    try {
      info = await this.worktrees.createForTask({
        repo: input.repo,
        taskId: placeholder.id,
        branch,
      })
    } catch (err) {
      // Roll back the placeholder if worktree creation failed —
      // otherwise the index has a phantom task with no on-disk state.
      // We use archive("canceled") rather than a hard delete because
      // `TaskIndexStore` has no public `delete` and CLAUDE.md forbids
      // adding one without consent.
      try {
        await this.store.archive(placeholder.id, "canceled")
      } catch {
        /* swallow secondary failure */
      }
      this.refreshSignal()
      throw err
    }

    const finalized = await this.store.update(placeholder.id, {
      branch: info.branch,
      worktreePath: info.path,
    })
    this.refreshSignal()
    return finalized
  }

  /**
   * Run a task. First call spawns; subsequent calls (or calls with a
   * `sessionId` already on the task) resume.
   *
   * Status transitions:
   *   - `backlog` → `in_progress` (always allowed)
   *   - `in_progress` → `in_progress` (no-op; already running). We
   *     allow this for `runTask(id, prompt)` calls coming from a chat
   *     send while the task is mid-stream, since the chat composer
   *     calls runTask on every Enter. In that case we just resume.
   *   - `done` / `in_review` / `error` → `in_progress` (resume — user
   *     is continuing a finished session). Allowed.
   *   - `canceled` → `in_progress` is rejected; canceled is terminal.
   */
  async runTask(id: TaskId | string, prompt?: string): Promise<void> {
    const task = this.requireTask(id)
    if (task.status === "canceled") {
      throw new IllegalTransitionError(task.status, "in_progress", String(id))
    }

    // Cap check covers both fresh runs and resumes — every running
    // task counts as one slot.
    if (this.handles.has(task.id) === false) {
      const running = this.countRunning()
      if (running >= CONCURRENCY_CAP) {
        throw new ConcurrencyCapError()
      }
    }

    // Use the prompt; if none provided, fall back to a single space so
    // the engine has *something* to send (Claude Code's CLI rejects an
    // empty `-p`). The chat composer always supplies a real prompt;
    // this fallback exists so the unit test for "runTask without
    // chatting" doesn't trip.
    const promptToSend = prompt && prompt.length > 0 ? prompt : " "

    let handle: SessionHandle
    if (task.sessionId) {
      handle = await this.engine.resume(task.sessionId, promptToSend, {
        env: { KOBE_RESUME_CWD: task.worktreePath },
      })
    } else {
      handle = await this.engine.spawn(task.worktreePath, promptToSend)
      // Persist the freshly-allocated session id so a future kobe
      // restart can resume.
      await this.store.update(task.id, { sessionId: handle.sessionId })
    }
    this.handles.set(task.id, handle)

    if (task.status !== "in_progress") {
      await this.store.update(task.id, { status: "in_progress" })
    }
    this.refreshSignal()

    // Spin the pump. Captures `task.id` so the closure references the
    // right task even if the user creates more concurrently.
    const pump = this.pumpEvents(task.id, handle)
    this.pumps.set(task.id, pump)
    // Don't await — the caller wants to return as soon as the engine
    // is started, not when it finishes. The pump runs to completion in
    // the background.
    pump.catch((err) => {
      // Surface pump failures via the event bus instead of unhandled
      // rejection. The test suite explicitly waits for terminal events.
      this.dispatchEvent(task.id, {
        type: "error",
        message: `pump failure: ${err instanceof Error ? err.message : String(err)}`,
      })
    })
  }

  /**
   * Pause a running task. Status `in_progress` → `backlog`. Resets the
   * engine handle so the next runTask resumes cleanly (the sessionId
   * stays on the task).
   */
  async pauseTask(id: TaskId | string): Promise<void> {
    const task = this.requireTask(id)
    if (task.status !== "in_progress") {
      throw new IllegalTransitionError(task.status, "backlog", String(id))
    }
    const handle = this.handles.get(task.id)
    if (handle) {
      await this.engine.stop(handle)
      this.handles.delete(task.id)
    }
    await this.store.update(task.id, { status: "backlog" })
    this.refreshSignal()
  }

  /**
   * Move a task to a terminal status (`done` or `canceled`). Stops the
   * engine if running. Idempotent for already-archived tasks.
   */
  async archiveTask(id: TaskId | string, status: "done" | "canceled"): Promise<void> {
    const task = this.requireTask(id)
    if (status !== "done" && status !== "canceled") {
      throw new IllegalTransitionError(task.status, status, String(id))
    }
    const handle = this.handles.get(task.id)
    if (handle) {
      await this.engine.stop(handle)
      this.handles.delete(task.id)
    }
    await this.store.archive(task.id, status)
    this.refreshSignal()
  }

  /**
   * Subscribe to engine events for one task. Returns an unsubscribe
   * function. Multiple subscribers are supported; events are
   * broadcast in registration order. Subscribers receive ALL events
   * the engine emits — `assistant.delta`, `tool.start`, `tool.result`,
   * `usage`, `done`, `error`. The chat pane filters which to render.
   */
  subscribeEvents(id: TaskId | string, cb: (ev: EngineEvent) => void): Unsubscribe {
    const taskId = (this.store.get(id)?.id ?? id) as TaskId
    let set = this.subscribers.get(taskId)
    if (!set) {
      set = new Set()
      this.subscribers.set(taskId, set)
    }
    set.add(cb)
    return () => {
      const cur = this.subscribers.get(taskId)
      if (!cur) return
      cur.delete(cb)
      if (cur.size === 0) this.subscribers.delete(taskId)
    }
  }

  /**
   * Wait for all in-flight pumps to settle. Test-only utility — the
   * production UI does not block on this.
   */
  async _waitForPumpsIdle(): Promise<void> {
    const pumps = Array.from(this.pumps.values())
    await Promise.allSettled(pumps)
  }

  // ---------- internals ----------

  private requireTask(id: TaskId | string): Task {
    const task = this.store.get(id)
    if (!task) throw new TaskNotFoundError(String(id))
    return task
  }

  private countRunning(): number {
    let n = 0
    for (const t of this.store.list()) {
      if (t.status === "in_progress") n++
    }
    return n
  }

  private refreshSignal(): void {
    this.setTasks(this.store.list())
  }

  private dispatchEvent(taskId: TaskId, ev: EngineEvent): void {
    const set = this.subscribers.get(taskId)
    if (!set) return
    for (const cb of set) {
      try {
        cb(ev)
      } catch (err) {
        // Swallow subscriber errors — one bad listener must not break
        // the bus for others. Log so it isn't silent.
        // eslint-disable-next-line no-console
        console.error("[kobe orchestrator] subscriber threw:", err)
      }
    }
  }

  private async pumpEvents(taskId: TaskId, handle: SessionHandle): Promise<void> {
    let terminal: "done" | "error" | null = null
    try {
      for await (const ev of this.engine.stream(handle)) {
        this.dispatchEvent(taskId, ev)
        if (ev.type === "done") terminal = "done"
        else if (ev.type === "error") terminal = "error"
      }
    } finally {
      // Drop the handle whether we exited cleanly or via throw.
      this.handles.delete(taskId)
      this.pumps.delete(taskId)
      if (terminal) {
        try {
          await this.store.update(taskId, {
            status: terminal === "done" ? "done" : "error",
          })
        } catch {
          /* store may have been cleared in tests; ignore */
        }
      }
      this.refreshSignal()
    }
  }
}

/**
 * Build `kobe/<slug>-<ulid-suffix-4>` from a user-supplied title and
 * a freshly-minted ulid. The 4-char suffix is the last 4 chars of the
 * ulid which gives ~1M of randomness per ms — collision-free in
 * practice. We slug aggressively (lowercase, alnum + hyphen) and cap
 * at 32 chars so the branch name stays short on `git log`.
 */
function autoBranch(title: string, taskId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  const suffix = taskId.slice(-4).toLowerCase()
  const base = slug || "task"
  return `kobe/${base}-${suffix}`
}
