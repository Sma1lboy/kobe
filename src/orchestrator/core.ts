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
  AskQuestionEntry,
  AskQuestionPayload,
  EngineEvent,
  Message,
  OrchestratorEvent,
  QuestionOption,
  SessionHandle,
  UserInputPayload,
  UserInputResponse,
} from "../types/engine.ts"
import type { ChatTab, PermissionMode, Task, TaskId, TaskStatus } from "../types/task.ts"
import { suggestBranchSlug } from "./branch-suggestion.ts"
import { ulid } from "./index/ulid.ts"
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
 * Composite (taskId, tabId) key for the engine's per-tab handle, the
 * subscriber bus, and the pump map. Centralised so all three keep the
 * same shape and a typo doesn't silently split a tab's stream from its
 * subscribers.
 */
function tabKey(taskId: string, tabId: string): string {
  return `${taskId}:${tabId}`
}

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
  /**
   * Engine session handles keyed by `${taskId}:${tabId}`. Each chat tab
   * within a task owns an independent session; closing a tab tears down
   * just its handle, leaving sibling tabs alive.
   */
  private readonly handles = new Map<string, SessionHandle>()
  /**
   * Event-bus subscribers keyed by `${taskId}:${tabId}`. Subscribers
   * stay attached when the user switches tabs in the UI — the switch is
   * a render-side change only; engine streams keep flowing in the
   * background so a tab's "done" arrives even if the user isn't looking.
   */
  private readonly subscribers = new Map<string, Set<(ev: OrchestratorEvent) => void>>()
  /** Background pump promises — kept so tests can `await` settle. */
  private readonly pumps = new Map<string, Promise<void>>()
  /**
   * Pending user-input requests, keyed by taskId then by requestId.
   * Populated when the engine emits a tool that pauses for user input
   * (currently `ExitPlanMode`); cleared in `respondToInput` when the
   * user answers. Not persisted — request state is per-process.
   */
  private readonly pendingInput = new Map<TaskId, Map<string, UserInputPayload>>()
  /** Counter for generating unique requestIds across the orchestrator's lifetime. */
  private requestIdCounter = 0
  /**
   * Process-scoped record of branch/baseRef the user picked at
   * `createTask` time but hasn't committed to disk yet (we allocate
   * the worktree lazily on first `runTask`). Lost on kobe restart;
   * `ensureWorktree` falls back to deterministic defaults if the
   * map is missing the entry.
   */
  private readonly pendingWorktreeOpts = new Map<TaskId, { branch?: string; baseRef?: string }>()

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
   * Snapshot the pending user-input requests for a task in the order
   * the orchestrator received them (oldest first). Test-only seam — the
   * production chat doesn't need this because each ApprovalRow /
   * QuestionRow already carries its own requestId via the
   * `user_input.request` event. The behavior tests use this to discover
   * a freshly-emitted requestId so they can drive `respondToInput`
   * without faking a mouse click.
   *
   * Returns an empty array when the task has no pending requests
   * (or doesn't exist). Defensive copy so callers can't mutate
   * orchestrator state.
   */
  peekPendingInput(id: TaskId | string): Array<{ requestId: string; payload: UserInputPayload }> {
    const bucket = this.pendingInput.get(id as TaskId)
    if (!bucket) return []
    return Array.from(bucket.entries()).map(([requestId, payload]) => ({ requestId, payload }))
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

    // Lazy worktree: createTask only persists the task record. The
    // worktree (and its branch) are allocated by `runTask` on the
    // first user submit. Rationale:
    //   - createTask never fails on git state (dirty repo, branch
    //     conflict, missing baseRef) — those errors surface inside
    //     the chat where the user can read + react.
    //   - The user can rename or cancel the task without leaving a
    //     stranded worktree on disk.
    //   - File-tree / terminal / PR panes already handle empty
    //     `worktreePath` (treat as "no worktree yet").
    //
    // `pendingBranch` and `pendingBaseRef` are stored alongside the
    // task so runTask knows what to allocate. We don't expose them on
    // the public Task type; they live in a separate `pending` field
    // on the persisted record. (Implementation note: we squirrel them
    // into the in-memory `pendingWorktreeOpts` map keyed by task id.
    // For now this is process-scoped — a kobe restart between
    // createTask and runTask drops the user's branch/baseRef choice,
    // which is acceptable because the new-task flow is always
    // followed by an immediate first prompt.)
    const created = await this.store.create({
      title: finalTitle,
      repo: input.repo,
      branch: "", // populated by runTask when worktree is allocated
      worktreePath: "", // populated by runTask when worktree is allocated
      sessionId: null,
      status: "backlog",
      archived: false,
    })
    // Branch is allocated lazily so the auto-name's ulid suffix uses
    // the real task id (computing it before `store.create` would slug
    // an empty suffix). Persist only the user's explicit override (if
    // any) and baseRef; ensureWorktree re-derives auto names.
    this.pendingWorktreeOpts.set(created.id, {
      branch: input.branch,
      baseRef: input.baseRef,
    })
    return created
  }

  /**
   * Allocate the worktree for a task that was created with the lazy
   * (Wave 4.X) flow. Idempotent: returns the task untouched if
   * `worktreePath` is already populated. Called by `runTask` on the
   * first submit; not part of the public API because it's a
   * runTask-internal step.
   *
   * Branch naming: if the user supplied an explicit `branch` at
   * createTask time, we honor it. Otherwise we allocate a temp name
   * `kobe/tmp-<ulid-suffix>` so the engine can start streaming
   * immediately, and runTask kicks off `suggestBranchSlug` in the
   * background to rename to a meaningful name without blocking.
   */
  private async ensureWorktree(task: Task): Promise<Task> {
    if (task.worktreePath) return task
    const opts = this.pendingWorktreeOpts.get(task.id)
    const branch = opts?.branch ?? `kobe/tmp-${task.id.slice(-8).toLowerCase()}`
    const baseRef = opts?.baseRef
    const info = await this.worktrees.createForTask({
      repo: task.repo,
      taskId: task.id,
      branch,
      baseRef,
    })
    this.pendingWorktreeOpts.delete(task.id)
    return await this.store.update(task.id, {
      branch: info.branch,
      worktreePath: info.path,
    })
  }

  /**
   * Replace a temp `kobe/tmp-<ulid>` branch with a meaningful name
   * derived from `prompt` via a one-shot `claude -p` suggestion. Runs
   * in the background — failures are swallowed so the chat never
   * sees a "branch rename failed" banner. Skips:
   *   - tasks whose branch isn't a tmp branch (user picked it)
   *   - empty prompts (nothing to derive from)
   *   - claude binary missing / suggestion failed / timed out
   */
  private async maybeRenameTempBranch(taskId: TaskId, tabId: string, prompt: string | undefined): Promise<void> {
    if (!prompt || prompt.trim().length === 0) return
    const task = this.store.get(taskId)
    if (!task || !task.worktreePath) return
    if (!task.branch.startsWith("kobe/tmp-")) return

    // Surface that the suggestion is in flight so the user sees what
    // the temp branch name is going to become.
    this.dispatchEvent(taskId, tabId, {
      type: "system.info",
      text: "branch: choosing a name…",
    })

    const slug = await suggestBranchSlug(prompt)
    if (!slug) return

    // Re-read in case the task changed (rename, archive) while we
    // were waiting for claude.
    const fresh = this.store.get(taskId)
    if (!fresh || !fresh.worktreePath) return
    if (fresh.branch !== task.branch) return // someone else renamed

    const newBranch = `kobe/${slug}-${taskId.slice(-4).toLowerCase()}`
    if (newBranch === fresh.branch) return

    try {
      await this.worktrees.renameBranch(fresh.worktreePath, fresh.branch, newBranch)
      await this.store.update(taskId, { branch: newBranch })
      this.dispatchEvent(taskId, tabId, {
        type: "system.info",
        text: `branch: renamed to ${newBranch}`,
      })
    } catch {
      /* leave the temp name; user can rename via `r` in sidebar */
    }
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
  async runTask(id: TaskId | string, prompt?: string, tabId?: string): Promise<void> {
    let task = this.requireTask(id)
    if (task.status === "canceled") {
      throw new IllegalTransitionError(task.status, "in_progress", String(id))
    }

    // Lazy worktree: tasks created via the new-task dialog land here
    // with `worktreePath: ""`. Allocate it now (idempotent — returns
    // the task untouched if it already has a worktree).
    const isFirstAllocation = !task.worktreePath
    if (isFirstAllocation) {
      task = await this.ensureWorktree(task)
      // Surface the allocation as a dim system row so the user can
      // see the lazy infra running underneath their first prompt.
      const targetTabForInfo = this.resolveTab(task, tabId)
      this.dispatchEvent(task.id, targetTabForInfo.id, {
        type: "system.info",
        text: `worktree: ${task.worktreePath} (branch ${task.branch})`,
      })
    }
    // Background: kick off a `claude -p` suggestion to replace the
    // temp branch name with something meaningful. Fire-and-forget;
    // never blocks the chat. The rename method emits its own
    // system.info row when it succeeds.
    if (isFirstAllocation && prompt) {
      const renameTabId = this.resolveTab(task, tabId).id
      void this.maybeRenameTempBranch(task.id, renameTabId, prompt)
    }

    // Resolve the target tab. Default to the active one so existing
    // single-tab callers keep working. We don't auto-create — the
    // caller is expected to know the tab id (the active one is fine).
    const targetTab = this.resolveTab(task, tabId)
    const key = tabKey(task.id, targetTab.id)

    // Cap check covers both fresh runs and resumes — every running
    // tab counts as one slot. (We deliberately count tabs not tasks:
    // five concurrent tabs across one task is the same engine load as
    // five tasks with one tab each.)
    if (this.handles.has(key) === false) {
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
    if (targetTab.sessionId) {
      handle = await this.engine.resume(targetTab.sessionId, promptToSend, {
        env: { KOBE_RESUME_CWD: task.worktreePath },
        permissionMode: task.permissionMode,
        model: task.model,
      })
    } else {
      handle = await this.engine.spawn(task.worktreePath, promptToSend, {
        permissionMode: task.permissionMode,
        model: task.model,
      })
      // Persist the freshly-allocated session id back onto the tab so
      // a future kobe restart can resume.
      await this.updateTab(task.id, targetTab.id, { sessionId: handle.sessionId })
      // First user submit on a placeholder-titled task → derive the
      // sidebar label from the prompt.
      if (task.title === PLACEHOLDER_TASK_TITLE && prompt && prompt.trim().length > 0) {
        const derived = deriveTitleFromPrompt(prompt)
        if (derived) await this.store.update(task.id, { title: derived })
      }
    }
    this.handles.set(key, handle)

    if (task.status !== "in_progress") {
      await this.store.update(task.id, { status: "in_progress" })
    }

    // Spin the pump. Captures `key` so the closure references the
    // right tab even if the user spawns more concurrently.
    const pump = this.pumpEvents(task.id, targetTab.id, handle)
    this.pumps.set(key, pump)
    // Don't await — the caller wants to return as soon as the engine
    // is started, not when it finishes. The pump runs to completion in
    // the background.
    pump.catch((err) => {
      // Surface pump failures via the event bus instead of unhandled
      // rejection. The test suite explicitly waits for terminal events.
      this.dispatchEvent(task.id, targetTab.id, {
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
    // can't poison the runTask call. PR injection always targets the
    // task's currently-active tab (the user pressed the button while
    // looking at it).
    const activeTab = this.resolveTab(task)
    this.dispatchEvent(task.id, activeTab.id, { type: "user.inject", text: prompt })
    await this.runTask(task.id, prompt, activeTab.id)
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
    // Multi-tab caveat: pendingInput is keyed by taskId only (not
    // tabId) so we route the resolved/inject events through the
    // task's active tab. In single-tab tasks this matches exactly;
    // for multi-tab, an approval surfaced from a non-active tab will
    // still resolve correctly but the chat banner update lands on the
    // active tab. Tightening this requires storing tabId in
    // pendingInput, which is a follow-up.
    const tabId = task.activeTabId
    this.dispatchEvent(task.id, tabId, { type: "user_input.resolved", requestId, response })

    const prompt = renderUserInputResponsePrompt(pending, response)
    if (!prompt) return
    this.dispatchEvent(task.id, tabId, { type: "user.inject", text: prompt })
    await this.runTask(task.id, prompt, tabId)
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
    // Stop every tab that has a live handle for this task. A task is
    // "running" iff at least one of its tabs has an engine pump open;
    // pausing means no tab should be live.
    await this.stopAllTabsForTask(task.id)
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
    await this.stopAllTabsForTask(task.id)
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
   * Rename a task. The sidebar's `r` keypress opens a small dialog that
   * defaults to the current title; on submit we land here. Mirrors the
   * shape of {@link setArchived} / {@link setPermissionMode} /
   * {@link setModel} (require-task → no-op if unchanged → store.update).
   *
   * `createTask` derives an initial title from the first prompt
   * (PLACEHOLDER_TASK_TITLE → first-40-chars of the prompt). This is the
   * user-driven override path for "the auto-derived label is wrong / I
   * want to organise my sidebar."
   *
   * Validation:
   *   - Throws on empty / whitespace-only input. We trim first, then
   *     reject if the result is empty — the new-task dialog already
   *     guards this on its end, but defending in depth here means a
   *     mis-wired UI path can't write a blank label and orphan a row in
   *     the sidebar.
   *   - Same-as-current (after trim) is a no-op so a user "editing" the
   *     title to the same value doesn't churn the manifest file or fire
   *     a redundant store notification.
   *
   * No length cap is enforced here. {@link deriveTitleFromPrompt}
   * applies one when a title is auto-derived, but the user clicking
   * "rename" is signalling they want the value as typed. The sidebar
   * truncates on render (terminal column width clip), so an over-long
   * title is a visual problem, not a corruption hazard.
   */
  async setTitle(id: TaskId | string, title: string): Promise<void> {
    const task = this.requireTask(id)
    const trimmed = typeof title === "string" ? title.trim() : ""
    if (trimmed.length === 0) {
      throw new Error("setTitle: title is required (empty or whitespace-only rejected)")
    }
    if (task.title === trimmed) return
    await this.store.update(task.id, { title: trimmed })
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
  subscribeEvents(id: TaskId | string, cb: (ev: OrchestratorEvent) => void, tabId?: string): Unsubscribe {
    const task = this.store.get(id)
    const taskId = (task?.id ?? id) as TaskId
    // Resolve the tab id at subscription time. Falls back to the task's
    // active tab so single-tab callers stay terse. If the task is
    // unknown (caller subscribed eagerly with an id that the store
    // hasn't seen yet), we use the literal taskId as the tab key
    // suffix — this matches the orchestrator's defensive behaviour for
    // unknown ids elsewhere.
    const resolvedTabId = tabId ?? task?.activeTabId ?? String(taskId)
    const key = tabKey(taskId, resolvedTabId)
    let set = this.subscribers.get(key)
    if (!set) {
      set = new Set()
      this.subscribers.set(key, set)
    }
    set.add(cb)
    return () => {
      const cur = this.subscribers.get(key)
      if (!cur) return
      cur.delete(cb)
      if (cur.size === 0) this.subscribers.delete(key)
    }
  }

  /**
   * Append a new chat tab to a task. The tab starts with no session
   * (null sessionId); it spawns its own session on first `runTask` for
   * that tab. The orchestrator does NOT auto-switch the active tab —
   * that's a UI concern (the chat shell decides when to set focus on
   * the new tab).
   *
   * Returns the freshly-created tab.
   */
  async createTab(id: TaskId | string, opts: { title?: string } = {}): Promise<ChatTab> {
    const task = this.requireTask(id)
    const tab: ChatTab = {
      id: ulid(),
      sessionId: null,
      createdAt: new Date().toISOString(),
      ...(opts.title ? { title: opts.title } : {}),
    }
    const tabs = [...task.tabs, tab]
    await this.store.update(task.id, { tabs })
    return tab
  }

  /**
   * Close (= remove) a chat tab. Stops the tab's engine session if
   * running. Refuses to close the last remaining tab — kobe's chat
   * shell always has at least one tab. If the closed tab was the
   * active one, the next-most-recent tab becomes active (index − 1,
   * or 0 if we closed index 0). The new active tab id is returned so
   * the UI can reconcile its focus signal.
   */
  async closeTab(id: TaskId | string, tabId: string): Promise<string> {
    const task = this.requireTask(id)
    if (task.tabs.length <= 1) {
      throw new Error(`closeTab: refusing to close the last tab on task ${task.id}`)
    }
    const idx = task.tabs.findIndex((t) => t.id === tabId)
    if (idx < 0) {
      throw new Error(`closeTab: tab ${tabId} not found on task ${task.id}`)
    }

    // Tear down this tab's engine session FIRST so the pump's
    // terminal-status update doesn't race with our store.update below
    // and clobber the pruned `tabs` array. stopTab is a no-op when
    // there's no live handle.
    await this.stopTab(task.id, tabId)

    const remaining = task.tabs.filter((t) => t.id !== tabId)
    let nextActive = task.activeTabId
    if (task.activeTabId === tabId) {
      // Switch to the previous tab in the visual order; if the closed
      // tab was index 0, the new index 0 takes its place.
      const prevIdx = Math.max(0, idx - 1)
      nextActive = remaining[prevIdx]?.id ?? remaining[0]?.id ?? ""
    }
    await this.store.update(task.id, { tabs: remaining, activeTabId: nextActive })
    return nextActive
  }

  /**
   * Set which tab is active. Idempotent. Tab must exist on the task.
   * The orchestrator stays out of UI decisions — it just persists
   * which tab the user last interacted with so a kobe restart shows
   * the same one.
   */
  async setActiveTab(id: TaskId | string, tabId: string): Promise<void> {
    const task = this.requireTask(id)
    if (!task.tabs.some((t) => t.id === tabId)) {
      throw new Error(`setActiveTab: tab ${tabId} not found on task ${task.id}`)
    }
    if (task.activeTabId === tabId) return
    await this.store.update(task.id, { activeTabId: tabId })
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

  /**
   * Resolve a chat tab on a task. When `tabId` is omitted, returns the
   * task's active tab. Throws if the tab id is given but not found.
   */
  private resolveTab(task: Task, tabId?: string): ChatTab {
    if (tabId) {
      const found = task.tabs.find((t) => t.id === tabId)
      if (!found) throw new Error(`tab not found on task ${task.id}: ${tabId}`)
      return found
    }
    const active = task.tabs.find((t) => t.id === task.activeTabId) ?? task.tabs[0]
    if (!active) {
      // Should be impossible — the store invariant guarantees
      // tabs.length >= 1. Throw rather than fabricate one silently.
      throw new Error(`task ${task.id} has no tabs`)
    }
    return active
  }

  /**
   * Patch a single tab's persisted fields. Used internally to write
   * back a freshly-allocated sessionId after the engine spawns.
   */
  private async updateTab(taskId: TaskId, tabId: string, patch: Partial<ChatTab>): Promise<void> {
    const cur = this.store.get(taskId)
    if (!cur) return
    const tabs = cur.tabs.map((t) => (t.id === tabId ? { ...t, ...patch, id: t.id } : t))
    await this.store.update(taskId, { tabs })
  }

  /**
   * Stop the engine handle for a single tab (if any). Idempotent.
   * Drops the handle from the map. The pump's `finally` will also try
   * to drop it — both calls are safe.
   */
  private async stopTab(taskId: TaskId, tabId: string): Promise<void> {
    const key = tabKey(taskId, tabId)
    const handle = this.handles.get(key)
    if (!handle) return
    try {
      await this.engine.stop(handle)
    } finally {
      this.handles.delete(key)
    }
  }

  /**
   * Stop every live tab handle on a task. Used by pause / archive /
   * delete — those are task-level lifecycle operations that take down
   * all sessions sharing the worktree.
   */
  private async stopAllTabsForTask(taskId: TaskId): Promise<void> {
    const prefix = `${taskId}:`
    const keys = Array.from(this.handles.keys()).filter((k) => k.startsWith(prefix))
    for (const key of keys) {
      const handle = this.handles.get(key)
      if (!handle) continue
      try {
        await this.engine.stop(handle)
      } catch {
        // Best-effort; the lifecycle method that called us will surface
        // task-level state regardless.
      }
      this.handles.delete(key)
    }
  }

  private countRunning(): number {
    // Count tabs with live handles, not tasks. Concurrency cap is per
    // engine session: five tabs on one task or five tasks with one tab
    // each both count as five.
    return this.handles.size
  }

  private dispatchEvent(taskId: TaskId, tabId: string, ev: OrchestratorEvent): void {
    const set = this.subscribers.get(tabKey(taskId, tabId))
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

  private async pumpEvents(taskId: TaskId, tabId: string, handle: SessionHandle): Promise<void> {
    const key = tabKey(taskId, tabId)
    let terminal: "done" | "error" | null = null
    let killedForInput = false
    try {
      for await (const ev of this.engine.stream(handle)) {
        this.dispatchEvent(taskId, tabId, ev)
        // Detect tools that pause for user input. Piggyback on
        // `tool.start` so the UI surfaces the approval banner without
        // waiting for the tool's file write to complete in the subprocess.
        const inputReq = detectUserInputFromEngineEvent(ev)
        if (inputReq) {
          const requestId = `req-${++this.requestIdCounter}`
          let bucket = this.pendingInput.get(taskId)
          if (!bucket) {
            bucket = new Map()
            this.pendingInput.set(taskId, bucket)
          }
          bucket.set(requestId, inputReq)
          this.dispatchEvent(taskId, tabId, {
            type: "user_input.request",
            requestId,
            payload: inputReq,
          })
          // STOP the subprocess. In `claude -p` mode the user-input
          // tools (ExitPlanMode, AskUserQuestion) return immediately
          // with empty/default answers and the model just keeps yapping
          // past the request — the picker shows up AFTER the model's
          // "looks like you didn't answer" text. Killing here freezes
          // the conversation at the request; respondToInput resumes the
          // same session via --resume with the user's actual answer.
          // Distinct from a `done`/`error` terminal so the finally
          // block doesn't write a terminal status — task stays in
          // in_progress while we wait for the user.
          killedForInput = true
          try {
            await this.engine.stop(handle)
          } catch {
            /* best-effort kill; the for-await still ends */
          }
          break
        }
        if (ev.type === "done") terminal = "done"
        else if (ev.type === "error") terminal = "error"
      }
    } finally {
      // Drop the handle whether we exited cleanly or via throw.
      this.handles.delete(key)
      this.pumps.delete(key)
      if (terminal && !killedForInput) {
        // Only flip the task's status to a terminal value when ALL
        // its tabs have stopped. With multi-tab, a single tab finishing
        // doesn't mean the task is done — the user may still have other
        // tabs streaming. We check after delete-from-handles above so
        // the count reflects "still live siblings."
        const stillLive = Array.from(this.handles.keys()).some((k) => k.startsWith(`${taskId}:`))
        if (!stillLive) {
          try {
            await this.store.update(taskId, {
              status: terminal === "done" ? "done" : "error",
            })
          } catch {
            /* store may have been cleared in tests; ignore */
          }
        }
      }
      // killedForInput case: leave status as in_progress — the user is
      // about to answer and we'll resume via respondToInput → runTask.
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
  // Both v1 and v2 of ExitPlanMode ship under the same name (see
  // refs/claude-code/src/tools/ExitPlanModeTool/constants.ts).
  if (ev.name === "ExitPlanMode" || ev.name === "ExitPlanModeV2Tool") {
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
  if (ev.name === "AskUserQuestion") {
    return parseAskUserQuestionInput(ev.input)
  }
  return null
}

/**
 * Pull a typed AskQuestion payload out of the raw tool input. Defensive:
 * the shape is documented (refs/claude-code/src/tools/AskUserQuestionTool/
 * AskUserQuestionTool.tsx schema) but we tolerate missing optional
 * fields rather than dropping the whole request. Returns null only
 * when the input has no usable question with at least one option.
 */
function parseAskUserQuestionInput(input: unknown): AskQuestionPayload | null {
  if (!input || typeof input !== "object") return null
  const obj = input as Record<string, unknown>
  if (!Array.isArray(obj.questions)) return null
  const out: AskQuestionEntry[] = []
  for (const q of obj.questions) {
    if (!q || typeof q !== "object") continue
    const qo = q as Record<string, unknown>
    const question = typeof qo.question === "string" ? qo.question : ""
    if (!question) continue
    const header = typeof qo.header === "string" ? qo.header : ""
    const multiSelect = qo.multiSelect === true
    const opts = Array.isArray(qo.options) ? qo.options : []
    const options: QuestionOption[] = []
    for (const o of opts) {
      if (!o || typeof o !== "object") continue
      const oo = o as Record<string, unknown>
      const label = typeof oo.label === "string" ? oo.label : ""
      if (!label) continue
      const description = typeof oo.description === "string" ? oo.description : ""
      options.push({ label, description })
    }
    if (options.length === 0) continue
    out.push({ question, header, multiSelect, options })
  }
  if (out.length === 0) return null
  return { kind: "ask_question", questions: out }
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
  if (req.kind === "ask_question" && response.kind === "ask_question") {
    // One bullet per asked question with the user's answer. We
    // iterate `req.questions` (not `response.answers`) so unanswered
    // questions surface as "(no answer)" rather than disappearing —
    // makes the model's continuation predictable when the user
    // skipped one (e.g. multi-select with zero picks).
    const lines: string[] = ["You asked:"]
    for (const q of req.questions) {
      const ans = response.answers[q.question]
      lines.push(`- ${q.question} → ${ans && ans.length > 0 ? ans : "(no answer)"}`)
    }
    lines.push("", "Please continue.")
    return lines.join("\n")
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
