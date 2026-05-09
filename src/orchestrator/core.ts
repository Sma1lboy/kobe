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
 *     Internally we keep a `createSignal<Task[]>` and rewrite it from a
 *     `TaskIndexStore.subscribe(cb)` listener. The store is the source
 *     of truth; the signal is a reactive mirror that wakes up on every
 *     mutation — without the orchestrator having to remember to call a
 *     `refreshSignal()` helper at every mutation point. The earlier
 *     "manual refresh after each mutation" pattern bit us when an
 *     unrelated code path mutated the store and the sidebar didn't
 *     redraw (Jackson's "task was done in JSON, sidebar still in
 *     Backlog" bug); the listener-based pattern is missable-by-design.
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
import type {
  AIEngine,
  EngineEvent,
  Message,
  OrchestratorEvent,
  SessionHandle,
  UserInputPayload,
  UserInputResponse,
} from "../types/engine.ts"
import type { PermissionMode, Task, TaskId, TaskStatus } from "../types/task.ts"
import type { TaskIndexStore, TaskIndexUnsubscribe } from "./index/store.ts"
import { gatherPRState, loadPRInstructionsTemplate, renderPRInstructions } from "./pr/index.ts"
import type { GitWorktreeManager } from "./worktree/manager.ts"

/** DI surface for the orchestrator. Tests pass test doubles here. */
export interface OrchestratorDeps {
  readonly engine: AIEngine
  readonly store: TaskIndexStore
  readonly worktrees: GitWorktreeManager
}

/** Maximum simultaneous `in_progress` tasks. From DESIGN §11.5. */
export const CONCURRENCY_CAP = 4

/**
 * Placeholder label used when the user creates a task without typing a
 * first prompt (the new flow — the dialog only asks for repo + branch).
 * `runTask` watches for this exact string on the first user submit and
 * back-fills a derived title from the prompt. See {@link runTask}.
 *
 * The sentinel must NEVER be a value `deriveTitleFromPrompt` could
 * produce — keep the leading paren so any user-typed prompt with this
 * exact text gets stripped of the parens by the deriver and won't
 * collide.
 */
export const PLACEHOLDER_TASK_TITLE = "(new task)"

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

/**
 * Thrown when {@link Orchestrator.requestPR} cannot satisfy its
 * preconditions (no worktree, no resolvable repo, task is canceled).
 * Carries a human-readable message; the button handler renders it.
 */
export class PRPreconditionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PRPreconditionError"
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
  /**
   * The user's first prompt. Optional — when present, the first ~40
   * characters become the auto-derived title (see
   * {@link deriveTitleFromPrompt}). When absent, the task is given a
   * placeholder title; the user can either type their first message in
   * the composer afterward (the orchestrator auto-updates the title
   * from the first non-empty `runTask` prompt — see {@link runTask})
   * or pass `title` explicitly here.
   *
   * Claude Code does NOT persist a separate "title" field on its
   * sessions, so we cannot recover one from `engine.readHistory`.
   */
  readonly prompt?: string
  /**
   * Optional explicit title override. When omitted (the common path),
   * we derive from `prompt` via {@link deriveTitleFromPrompt}. When
   * provided, callers take responsibility for length/format — we still
   * trim, but otherwise use it verbatim.
   */
  readonly title?: string
  /**
   * Branch override. When omitted, we generate
   * `kobe/<title-slug>-<ulid-suffix-4>` so two same-titled tasks
   * never collide.
   */
  readonly branch?: string
  /**
   * Base ref for the new branch. When omitted the new branch is rooted
   * at the repo's current HEAD (git's default). When set, it must be
   * something `git worktree add -b <new> <path> <baseRef>` accepts: a
   * branch name, tag, or commit SHA. The new-task dialog defaults this
   * to `"main"` so tasks always branch off the integration base unless
   * the user picks otherwise. If the ref doesn't resolve, the
   * underlying `git worktree add` fails and the error is surfaced to
   * the caller (the dialog displays it).
   */
  readonly baseRef?: string
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
  private readonly subscribers = new Map<TaskId, Set<(ev: OrchestratorEvent) => void>>()
  /** Background pump promises — kept so tests can `await` settle. */
  private readonly pumps = new Map<TaskId, Promise<void>>()
  /**
   * Pending user-input requests, keyed by taskId then by requestId.
   * Populated when the engine emits a tool that pauses for user input
   * (currently `ExitPlanMode`); cleared in `respondToInput` when the
   * user answers. Not persisted — request state is per-process.
   */
  private readonly pendingInput = new Map<TaskId, Map<string, UserInputPayload>>()
  /** Counter for generating unique requestIds across the orchestrator's lifetime. */
  private requestIdCounter = 0

  private readonly tasksAcc: Accessor<Task[]>
  private readonly setTasks: (next: Task[]) => void
  private readonly unsubscribeStore: TaskIndexUnsubscribe

  constructor(deps: OrchestratorDeps) {
    this.engine = deps.engine
    this.store = deps.store
    this.worktrees = deps.worktrees
    // Seed the signal with the current store snapshot so synchronous
    // readers (the Sidebar's `createMemo`) see the right initial
    // shape on the very first paint.
    const [tasks, setTasks] = createSignal<Task[]>(this.store.list())
    this.tasksAcc = tasks
    // Solid's `setSignal` accepts either a value or an updater; we
    // narrow to "always pass a fresh array" so the signal change is
    // detected by reference (Solid uses Object.is by default).
    this.setTasks = (next) => setTasks(() => next)
    // Wire the signal to the store's change notifier. From here on
    // every store mutation — whether driven by `runTask`, the pump's
    // `done`/`error` finally, `archiveTask`, `pauseTask`, or a future
    // code path we haven't written yet — refreshes the signal
    // automatically. No `refreshSignal()` calls needed at the
    // mutation sites.
    this.unsubscribeStore = this.store.subscribe((snapshot) => {
      this.setTasks(snapshot.slice())
    })
  }

  /** Solid `Accessor` that yields the current task list. */
  tasksSignal(): Accessor<Task[]> {
    return this.tasksAcc
  }

  /**
   * Tear down the store subscription. Test-only — production never
   * disposes the orchestrator before the process exits, but tests that
   * rebuild orchestrators repeatedly leak listeners without this.
   */
  dispose(): void {
    this.unsubscribeStore()
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
    // Title precedence: explicit `title` > derived from `prompt` >
    // placeholder. The placeholder is detected by `runTask` on the
    // first user submit — at which point the prompt becomes the
    // title via `deriveTitleFromPrompt`, so an empty initial title
    // is the common path now (the new-task dialog no longer asks).
    const explicitTitle = input.title?.trim() ?? ""
    const derivedTitle = explicitTitle || deriveTitleFromPrompt(input.prompt ?? "")
    const finalTitle = derivedTitle || PLACEHOLDER_TASK_TITLE

    // Persist with a placeholder branch so we have an id to compute
    // paths from. We then create the worktree, then patch the branch
    // back onto the record. Two-phase to keep a single ulid id flowing
    // through both the worktree path and the persisted record.
    const placeholder = await this.store.create({
      title: finalTitle,
      repo: input.repo,
      branch: "", // patched below
      worktreePath: "", // patched below
      sessionId: null,
      status: "backlog",
      archived: false,
    })

    // The branch slug uses the placeholder title (sentinel or derived),
    // not the eventual auto-renamed one — kobe-untitled-<ulid> works
    // for both paths and `runTask`'s title backfill leaves the branch
    // alone (renaming the on-disk worktree branch mid-session would
    // detach claude's recorded cwd).
    const branch = input.branch ?? autoBranch(finalTitle, placeholder.id)

    let info: { path: string; branch: string }
    try {
      info = await this.worktrees.createForTask({
        repo: input.repo,
        taskId: placeholder.id,
        branch,
        baseRef: input.baseRef,
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
      // No explicit refresh: `store.archive` notifies its listeners,
      // including our constructor-time subscription which mirrors the
      // signal.
      throw err
    }

    const finalized = await this.store.update(placeholder.id, {
      branch: info.branch,
      worktreePath: info.path,
    })
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
        permissionMode: task.permissionMode,
        model: task.model,
      })
    } else {
      handle = await this.engine.spawn(task.worktreePath, promptToSend, {
        permissionMode: task.permissionMode,
        model: task.model,
      })
      // Persist the freshly-allocated session id so a future kobe
      // restart can resume.
      await this.store.update(task.id, { sessionId: handle.sessionId })
      // First user submit on a placeholder-titled task → derive the
      // sidebar label from the prompt, same heuristic createTask used
      // when the dialog still asked for the first prompt. Only fires
      // when the title is the sentinel AND the prompt is non-empty
      // (an empty fallback prompt shouldn't rewrite the placeholder).
      if (task.title === PLACEHOLDER_TASK_TITLE && prompt && prompt.trim().length > 0) {
        const derived = deriveTitleFromPrompt(prompt)
        if (derived) await this.store.update(task.id, { title: derived })
      }
    }
    this.handles.set(task.id, handle)

    if (task.status !== "in_progress") {
      await this.store.update(task.id, { status: "in_progress" })
    }

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
   * Request a PR for a task by injecting a preset prompt into its chat.
   *
   * Design: kobe deliberately does NOT call `gh` / `glab` / etc itself.
   * Instead we render a markdown prompt that walks the agent through
   *   1. reviewing uncommitted changes,
   *   2. committing,
   *   3. pushing,
   *   4. opening the PR with `gh pr create --base <target>`,
   * and submit it as if the user had typed it (`runTask(taskId, prompt)`).
   * The agent's own shell + tool use figures out provider quirks. Per-
   * repo customization happens via `<worktreePath>/.kobe/pr-instructions.md`.
   *
   * Preconditions:
   *   - Task must exist (else {@link TaskNotFoundError}).
   *   - Task must NOT be `canceled` (terminal).
   *   - Task must have a non-empty `worktreePath` (the createTask
   *     placeholder window where worktreePath="" is briefly visible to
   *     the UI; the button is disabled in that window — but defend in
   *     depth here too).
   *   - Task must have a non-empty `repo`.
   *
   * On precondition failure, throws {@link PRPreconditionError} with a
   * human message. Other errors (template load, runTask) propagate as-is.
   * We deliberately do NOT swallow — the caller surfaces failures.
   */
  async requestPR(id: TaskId | string): Promise<void> {
    const task = this.requireTask(id)
    if (task.status === "canceled") {
      throw new PRPreconditionError("Cannot create a PR for a canceled task.")
    }
    if (!task.worktreePath) {
      throw new PRPreconditionError("Task has no worktree yet — wait for setup to finish.")
    }
    if (!task.repo) {
      throw new PRPreconditionError("Task has no repo path; cannot resolve git state.")
    }
    // gatherPRState never throws — each git call has its own fallback.
    const state = await gatherPRState(task.worktreePath)
    const template = await loadPRInstructionsTemplate(task.worktreePath)
    const prompt = renderPRInstructions(template, state)
    // Broadcast the synthetic user-inject event BEFORE runTask so the
    // chat renders the injected prompt as a normal user row in the same
    // tick the streaming starts. Subscribers swallow their own errors
    // (see dispatchEvent), so an unrelated subscriber failure here
    // can't poison the runTask call.
    this.dispatchEvent(task.id, { type: "user.inject", text: prompt })
    await this.runTask(task.id, prompt)
  }

  /**
   * Respond to a pending user-input request (currently only
   * `ExitPlanMode` plan approvals; AskUserQuestion next).
   *
   * Lookup is by `(taskId, requestId)`. Unknown requests are a no-op
   * — the caller may have raced a second click after the user already
   * answered, in which case there's nothing to do. We *don't* throw on
   * miss because the chat shouldn't have to defensive-check before
   * dispatching every click.
   *
   * On match:
   *   1. Drop the pending entry so a re-click is ignored.
   *   2. Broadcast `user_input.resolved` so the chat can flip the
   *      pending row's status to approved/rejected. Subscribers see
   *      this BEFORE the synthetic prompt's user.inject so the visual
   *      transition happens first.
   *   3. Synthesize a follow-up prompt (the wording the model will see
   *      as the "user's" reply) and run it via `runTask` — which
   *      resumes the existing session via `--resume <sessionId>`.
   *
   * The synthetic prompts are intentionally short and unambiguous to
   * keep the model's continuation behavior predictable. If we ever
   * want richer responses (e.g. an approve-with-comments flow), build
   * a kobe-side prompt builder rather than letting freeform text leak
   * in through the chat composer.
   */
  async respondToInput(id: TaskId | string, requestId: string, response: UserInputResponse): Promise<void> {
    const task = this.requireTask(id)
    const bucket = this.pendingInput.get(task.id)
    const pending = bucket?.get(requestId)
    if (!pending || !bucket) return
    bucket.delete(requestId)
    if (bucket.size === 0) this.pendingInput.delete(task.id)

    // Tell the chat the row is no longer pending. Fire BEFORE the
    // synthetic user.inject so the approval banner flips to its final
    // state in the same render frame the new user row appears.
    this.dispatchEvent(task.id, { type: "user_input.resolved", requestId, response })

    const prompt = renderUserInputResponsePrompt(pending, response)
    if (!prompt) return
    this.dispatchEvent(task.id, { type: "user.inject", text: prompt })
    await this.runTask(task.id, prompt)
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
  }

  /**
   * Toggle a task's `archived` flag. Wave 4.5 — sidebar splits into
   * "Working session" (active) and "Archives" views; pressing `a` flips
   * the cursor task between them. Non-destructive: the worktree, the
   * session, and the manifest entry all stay; only the visibility
   * filter changes.
   *
   * If `archived` is omitted, the flag is toggled. Pass it explicitly
   * to force a state.
   */
  async setArchived(id: TaskId | string, archived?: boolean): Promise<void> {
    const task = this.requireTask(id)
    const next = archived ?? !task.archived
    if (task.archived === next) return
    await this.store.update(task.id, { archived: next })
  }

  /**
   * Set the tool-permission mode on a task. Persisted to the manifest
   * so the next spawn/resume passes `--permission-mode <mode>` to the
   * Claude CLI. The composer's shift+tab cycler calls this; passing
   * `undefined` clears the field (CLI default).
   *
   * Note: this does NOT affect an in-flight session. A `--permission-mode`
   * flag at spawn time is honored by claude until the next spawn — there's
   * no live "demote permissions" wire. The mode change takes effect on
   * the next user submit. Surface this to the UI if it ever becomes
   * confusing in practice.
   */
  async setPermissionMode(id: TaskId | string, mode: PermissionMode | undefined): Promise<void> {
    const task = this.requireTask(id)
    if (task.permissionMode === mode) return
    await this.store.update(task.id, { permissionMode: mode })
  }

  /**
   * Set the per-task model. Persisted to the manifest and forwarded as
   * `claude --model <id>` on the next spawn/resume. Pass `undefined`
   * to clear (falls back to claude-code's default model). Like
   * permission mode, the change takes effect on the NEXT user turn —
   * an in-flight session keeps the model it was spawned with.
   */
  async setModel(id: TaskId | string, model: string | undefined): Promise<void> {
    const task = this.requireTask(id)
    if (task.model === model) return
    await this.store.update(task.id, { model })
  }

  /**
   * Fully delete a task: stop the engine, remove the worktree files,
   * remove the persisted chat history (Claude Code's JSONL session
   * file), and remove the task entry from the index.
   *
   * This is the "discard everything" verb the user gets when pressing
   * `d`. Earlier versions kept the task as `canceled` so history was
   * inspectable later — Jackson reversed that decision in Wave 4: if
   * the user says delete, drop it all. The confirm dialog wording in
   * `app.tsx` reflects that.
   *
   * Behavior:
   *   1. Defensive no-op if the task can't be resolved (UI may have a
   *      stale id after a fast-fingered cursor + key chord).
   *   2. If the task is `in_progress`, pause it first so the engine
   *      session unwinds cleanly. Engine-stop failures are logged and
   *      we proceed — the user already committed.
   *   3. Force-remove the worktree (the user confirmed; if the worktree
   *      is dirty they've accepted the loss). Failures are logged.
   *   4. Delete the persisted chat history if a sessionId exists.
   *      Failures are logged.
   *   5. Remove the task entry from the store. The listener bus fires
   *      and the sidebar drops the row.
   */
  async deleteTask(id: TaskId | string): Promise<void> {
    const task = this.store.get(id)
    if (!task) return // defensive — fast cursor races or stale id

    if (task.status === "in_progress") {
      try {
        await this.pauseTask(task.id)
      } catch (err) {
        // The engine may already be torn down (a `done` event arrived
        // mid-flight). Log and proceed — the user's intent is to
        // discard, not to babysit the engine state.
        // eslint-disable-next-line no-console
        console.error(`[kobe orchestrator] deleteTask: pauseTask failed for ${task.id}:`, err)
        this.handles.delete(task.id)
      }
    }

    if (task.worktreePath) {
      try {
        await this.worktrees.remove(task.worktreePath, { force: true })
      } catch (err) {
        // Disk-state cleanup failed (worktree directory missing, git
        // metadata entry stale, EBUSY, etc.). We still drop the task
        // so the UI reflects the user's intent. A future GC sweep can
        // reconcile drift.
        // eslint-disable-next-line no-console
        console.error(`[kobe orchestrator] deleteTask: worktree remove failed for ${task.id}:`, err)
      }
    }

    if (task.sessionId) {
      try {
        await this.engine.deleteHistory(task.sessionId)
      } catch (err) {
        // Best-effort: stale FS state (file already gone, permission
        // issue) shouldn't block the index drop.
        // eslint-disable-next-line no-console
        console.error(`[kobe orchestrator] deleteTask: deleteHistory failed for ${task.id}:`, err)
      }
    }

    await this.store.remove(task.id)
  }

  /**
   * Read persisted message history for a session. Thin pass-through to
   * `engine.readHistory(sessionId)` — exposed here (instead of leaking
   * the engine reference) so the chat pane has a single orchestrator
   * surface to consume. Wave 3 G's chat uses this on task switch.
   *
   * Returns `[]` if the engine has no record (e.g. brand-new session
   * not yet flushed to disk). Never throws — engine errors collapse
   * to an empty array, since a missing-history fallback is always
   * "render nothing for past."
   */
  async readHistory(sessionId: string): Promise<Message[]> {
    try {
      return await this.engine.readHistory(sessionId)
    } catch {
      return []
    }
  }

  /**
   * Subscribe to events for one task. Returns an unsubscribe
   * function. Multiple subscribers are supported; events are
   * broadcast in registration order. Subscribers receive engine
   * events (`assistant.delta`, `tool.start`, `tool.result`, `usage`,
   * `done`, `error`) AND synthetic `user.inject` events emitted by
   * orchestrator-driven prompt injections (e.g. `requestPR`). The
   * chat pane filters which to render.
   */
  subscribeEvents(id: TaskId | string, cb: (ev: OrchestratorEvent) => void): Unsubscribe {
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

  private dispatchEvent(taskId: TaskId, ev: OrchestratorEvent): void {
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
        // Detect tools that pause for user input. We piggyback on
        // `tool.start` rather than `tool.result` because the input
        // already has everything the UI needs (the plan body) — we
        // don't have to wait for the tool to finish writing the file
        // before showing the approval banner. The tool will still
        // complete inside the subprocess; we just race ahead to the
        // user-facing affordance.
        const inputReq = detectUserInputFromEngineEvent(ev)
        if (inputReq) {
          const requestId = `req-${++this.requestIdCounter}`
          let bucket = this.pendingInput.get(taskId)
          if (!bucket) {
            bucket = new Map()
            this.pendingInput.set(taskId, bucket)
          }
          bucket.set(requestId, inputReq)
          this.dispatchEvent(taskId, {
            type: "user_input.request",
            requestId,
            payload: inputReq,
          })
        }
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
      // The store's listener bus refreshes the signal automatically on
      // the `update` above. No explicit refresh needed here.
    }
  }
}

/* --------------------------------------------------------------------- */
/*  User-input request detection                                          */
/* --------------------------------------------------------------------- */

/**
 * Inspect an engine event to see if it represents a tool that pauses
 * the session for user input. Returns the typed payload to surface or
 * `null` when the event is uninteresting.
 *
 * Currently recognises {@link ExitPlanMode}; AskUserQuestion lands here
 * next. We dispatch on the `tool.start` event because:
 *
 *   1. The input already carries the plan body — we don't need to wait
 *      for the tool to finish writing a file on disk.
 *   2. In `claude -p` mode the subprocess can't actually wait for the
 *      user, so the tool returns very quickly with a "submitted for
 *      approval" marker and the subprocess exits. Reacting to start
 *      means the approval banner is up before the user sees the
 *      `done` event flip the spinner off.
 */
export function detectUserInputFromEngineEvent(ev: EngineEvent): UserInputPayload | null {
  if (ev.type !== "tool.start") return null
  // Both v1 and v2 of the tool ship under the same name (see
  // refs/claude-code/src/tools/ExitPlanModeTool/constants.ts).
  if (ev.name !== "ExitPlanMode" && ev.name !== "ExitPlanModeV2Tool") return null
  const input = ev.input
  if (!input || typeof input !== "object") return null
  const obj = input as Record<string, unknown>
  const plan = typeof obj.plan === "string" ? obj.plan : ""
  const filePath = typeof obj.filePath === "string" ? obj.filePath : null
  // We always emit even when the plan body is empty — an empty plan
  // is a model bug worth surfacing in the UI ("Approve this empty plan?")
  // rather than silently swallowing.
  return { kind: "approve_plan", plan, filePath }
}

/**
 * Build the synthetic user prompt sent on `--resume` after the user
 * answers a {@link UserInputRequestEvent}. Pure, exported for testing.
 *
 * Wording is deliberately minimal and direct — the model has the prior
 * context (the plan it just submitted), so this is just the "verdict"
 * not a re-statement. Returns `""` for unhandled response shapes so
 * the caller can short-circuit without sending an empty prompt.
 */
export function renderUserInputResponsePrompt(req: UserInputPayload, response: UserInputResponse): string {
  if (req.kind === "approve_plan" && response.kind === "approve_plan") {
    if (response.approve) {
      return "Plan approved. Please proceed with the implementation as outlined."
    }
    return "Plan rejected. Please reconsider the approach and present a revised plan."
  }
  return ""
}

/** Title cap for {@link deriveTitleFromPrompt}. Short enough to fit in a 42-char sidebar with status badge prefix. */
export const TITLE_CHAR_CAP = 40

/**
 * Reduce an arbitrary user prompt to a one-line sidebar label.
 *
 * Algorithm:
 *   1. Replace every run of whitespace (incl. newlines) with one space.
 *   2. Trim.
 *   3. If empty, return "" (caller decides whether to throw).
 *   4. If the result fits in {@link TITLE_CHAR_CAP}, return it.
 *   5. Otherwise truncate at the cap and append "…".
 *
 * Exported so the new-task dialog can preview the derived title before
 * the user submits, and so unit tests can hit it directly without
 * standing up a full orchestrator.
 */
export function deriveTitleFromPrompt(prompt: string): string {
  if (typeof prompt !== "string") return ""
  const collapsed = prompt.replace(/\s+/g, " ").trim()
  if (collapsed.length === 0) return ""
  if (collapsed.length <= TITLE_CHAR_CAP) return collapsed
  return `${collapsed.slice(0, TITLE_CHAR_CAP)}…`
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
