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
 *   - **Resume cwd — typed via `SpawnOpts.cwd`.** `AIEngine.resume()`
 *     has no positional cwd parameter (only `spawn()` does). The
 *     orchestrator runs in kobe's binary cwd, NOT the task's worktree,
 *     so we must always pass `task.worktreePath` when resuming. The
 *     primary channel is the typed `opts.cwd` field on `SpawnOpts`;
 *     engines MUST honour it. We also still set
 *     `opts.env.KOBE_RESUME_CWD` as a defensive duplicate — the env-var
 *     back-channel can be removed in a follow-up release once external
 *     consumers are confirmed off it. Both paths are load-bearing and
 *     tested below.
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
import { resolveDefaultModelId } from "../engine/claude-settings.ts"
import type {
  AIEngine,
  AskQuestionEntry,
  AskQuestionPayload,
  EngineEvent,
  Message,
  OrchestratorEvent,
  QuestionOption,
  SessionHandle,
  SessionMeta,
  UserInputPayload,
  UserInputResponse,
} from "../types/engine.ts"
import {
  type ChatTab,
  type PermissionMode,
  type Task,
  type TaskId,
  type TaskStatus,
  nextChatTabSeq,
} from "../types/task.ts"
import type { TaskIndexStore, TaskIndexUnsubscribe } from "./index/store.ts"
import { ulid } from "./index/ulid.ts"
import { MetadataSuggester } from "./metadata-suggester.ts"
import { InMemoryPendingInputBroker } from "./pending-input-broker.ts"
import { gatherPRState, loadPRInstructionsTemplate, renderPRInstructions } from "./pr/index.ts"
import { SessionPump } from "./session-pump.ts"
import type { GitWorktreeManager } from "./worktree/manager.ts"
import type { PendingInputBroker } from "../types/pending-input-broker.ts"

/** DI surface for the orchestrator. Tests pass test doubles here. */
export interface OrchestratorDeps {
  readonly engine: AIEngine
  readonly store: TaskIndexStore
  readonly worktrees: GitWorktreeManager
  /**
   * Optional override for the claude-driven metadata suggester
   * (branch slug today; worktree slug + title API exposed for
   * follow-ups). Tests inject a fake to avoid shelling out to
   * `claude -p`. When omitted, the orchestrator constructs a default
   * instance — the binary lookup inside it is lazy, so this stays
   * free at construction time.
   */
  readonly metadataSuggester?: MetadataSuggester
}

/** Maximum simultaneous `in_progress` tasks. From DESIGN §11.5. */
export const CONCURRENCY_CAP = 20

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

/**
 * Thrown when a caller tries to {@link Orchestrator.deleteTask} a task
 * with `kind: "main"`. Main tasks are bound to a saved repo entry, not
 * a kobe-allocated worktree — the user removes the repo from saved
 * repos instead, which archives the main task. The wording is the
 * literal copy the UI surfaces in its confirm dialog.
 */
export class CannotDeleteMainTaskError extends Error {
  constructor() {
    super("cannot delete a main task; remove the repo from saved repos instead")
    this.name = "CannotDeleteMainTaskError"
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
 * Live engine state for one chat tab, derived from the per-tab handles
 * map and the pending-input bucket. Surfaced reactively via
 * {@link Orchestrator.chatRunStateSignal} so the workspace tab strip can
 * paint a status dot per chat-tab chip (green = streaming, yellow =
 * paused on `AskUserQuestion` / `ExitPlanMode`, absent = idle).
 *
 * Per-tab fidelity matters: a task with two tabs where tab A is asking
 * the user a question and tab B is still streaming should show yellow
 * on A and green on B simultaneously — task-level aggregation would
 * mask the distinction.
 */
export type ChatRunState = "running" | "awaiting_input" | "idle"

export type TaskListListener = (snapshot: readonly Task[]) => void

/**
 * Compose the composite key used by {@link Orchestrator.chatRunStateSignal}
 * so callers don't need to know that the underlying shape is
 * `${taskId}:${tabId}`. Mirrors the private {@link tabKey} helper.
 */
export function chatRunStateKey(taskId: string, tabId: string): string {
  return `${taskId}:${tabId}`
}

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
 * Boil a `git worktree add` failure down to a one-line, user-actionable
 * message. The raw `GitCommandError` text from `src/orchestrator/worktree/git.ts`
 * is dense; we strip it here so the chat banner the user sees is short
 * enough to read at a glance.
 *
 * Exported for unit tests (and for any future surface that wants to
 * format the same error). The original error is preserved as `cause`
 * by the caller so anyone logging the chain still has the full story.
 */
export function summarizeWorktreeError(raw: string, repo: string, baseRef: string | null): string {
  const m = raw.toLowerCase()
  if (m.includes("invalid reference") || m.includes("unknown revision") || m.includes("not a valid object name")) {
    const ref = baseRef ?? "(none)"
    return `could not create worktree: base ref '${ref}' does not exist in ${repo}`
  }
  if (m.includes("not a git repository") || m.includes("not in a git directory")) {
    return `could not create worktree: ${repo} is not a git repository`
  }
  if (m.includes("permission denied") || m.includes("eacces")) {
    return `could not create worktree: permission denied writing into ${repo}/.claude/worktrees/`
  }
  if (m.includes("already exists") || m.includes("refusing to hijack") || m.includes("is on branch")) {
    return `could not create worktree: a stale worktree already exists for this task (try removing it under ${repo}/.claude/worktrees/)`
  }
  if (m.includes("enoent") || m.includes("does not exist")) {
    return `could not create worktree: ${repo} does not exist`
  }
  // Fallback: pull just the `fatal: <reason>` tail if present.
  const fatal = raw.match(/fatal:\s*([^\n]+)/i)
  if (fatal) return `could not create worktree: ${fatal[1]?.trim() ?? raw}`
  return `could not create worktree: ${raw.trim()}`
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
  private readonly metadataSuggester: MetadataSuggester
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
   * Pending user-input requests. Pulled out into a {@link PendingInputBroker}
   * adapter so the same shape can be replicated wire-side by
   * RemoteOrchestrator — see `src/types/pending-input-broker.ts` for the
   * seam rationale.
   *
   * The broker owns both the per-task bucket and the requestId-to-tabKey
   * side index that bumpRunState reads. Not persisted — request state is
   * per-process by design.
   */
  private readonly pendingInputBroker: PendingInputBroker = new InMemoryPendingInputBroker()
  /** Counter for generating unique requestIds across the orchestrator's lifetime. */
  private requestIdCounter = 0
  /**
   * Per-session driver. The pump is stateless across runs; we hold
   * one instance for the orchestrator's lifetime and reuse it for
   * every `runTask` (one pump.run() call per (Task, ChatTab) run).
   * Constructed in the constructor so the deps closure is built once.
   */
  private sessionPump!: SessionPump
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

  /**
   * Reactive map of `${taskId}:${tabId}` → live engine state. Computed
   * lazily from `handles` + `pendingInputRequestTab` and bumped via
   * {@link bumpRunState} every time those mutate. The workspace tab
   * strip reads this through {@link chatRunStateSignal} to paint a
   * per-chat-tab status dot.
   */
  private readonly runStateAcc: Accessor<ReadonlyMap<string, ChatRunState>>
  private readonly setRunState: (next: ReadonlyMap<string, ChatRunState>) => void

  constructor(deps: OrchestratorDeps) {
    this.engine = deps.engine
    this.store = deps.store
    this.worktrees = deps.worktrees
    this.metadataSuggester = deps.metadataSuggester ?? new MetadataSuggester()
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

    // Run-state signal. Seeds empty (no live tabs at construction time);
    // every handle / pendingInput mutation calls `bumpRunState` to
    // recompute. Solid compares by reference, so the bump always
    // allocates a fresh Map.
    const [runState, setRunState] = createSignal<ReadonlyMap<string, ChatRunState>>(new Map())
    this.runStateAcc = runState
    this.setRunState = (next) => setRunState(() => next)

    // Build the SessionPump with a closure over orchestrator-owned
    // deps. Pump never touches `handles` / `pumps` / `store` directly
    // — it returns a result and the orchestrator does the post-run
    // bookkeeping in `runPumpAndCleanup`.
    this.sessionPump = new SessionPump({
      engine: this.engine,
      broker: this.pendingInputBroker,
      dispatch: (taskId, tabId, ev) => this.dispatchEvent(taskId as TaskId, tabId, ev),
      nextRequestId: () => `req-${++this.requestIdCounter}`,
      onPendingInputChange: () => this.bumpRunState(),
    })
  }

  /**
   * Recompute the per-tab run-state map from `handles` +
   * `pendingInputRequestTab` and push it into the signal. Cheap (one
   * Map allocation, one signal write); call sites are every place
   * those collections mutate.
   *
   * Priority: `awaiting_input` > `running` > absent (idle). A tab that
   * just fired an `AskUserQuestion` always shows yellow even though
   * `engine.stop` clears its handle within the same turn — the dot
   * tracks the user's mental model (waiting on me) rather than the
   * subprocess's.
   */
  private bumpRunState(): void {
    const next = new Map<string, ChatRunState>()
    for (const tabKey of this.pendingInputBroker.awaitingTabKeys()) {
      next.set(tabKey, "awaiting_input")
    }
    for (const key of this.handles.keys()) {
      if (!next.has(key)) next.set(key, "running")
    }
    this.setRunState(next)
  }

  /**
   * Reactive accessor for per-tab run-state. Returns a map keyed by
   * `${taskId}:${tabId}` (compose via {@link chatRunStateKey}); absence
   * == idle. Wired to the workspace tab strip so each chat-tab chip can
   * paint a live dot (green = streaming, yellow = awaiting input).
   */
  chatRunStateSignal(): Accessor<ReadonlyMap<string, ChatRunState>> {
    return this.runStateAcc
  }

  /** Solid `Accessor` that yields the current task list. */
  tasksSignal(): Accessor<Task[]> {
    return this.tasksAcc
  }

  subscribeTasks(listener: TaskListListener): Unsubscribe {
    return this.store.subscribe(listener)
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
    return this.pendingInputBroker.snapshot(String(id))
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
   * Ensure a "main" task exists for `repo`. Idempotent: if a task with
   * `kind === "main"` and `repo === <repo>` is already in the store,
   * return it — possibly after unarchiving (see below). Otherwise create
   * one with `worktreePath === repo`, an empty `branch` (the live
   * current branch is resolved at display time, not stored), `status:
   * "backlog"`, and `kind: "main"`.
   *
   * Title: the repo basename. Stable across restarts so the sidebar's
   * pinned row reads `kobe`, not `/Users/.../kobe`.
   *
   * Repo uniqueness: the orchestrator owns this invariant; there's no DB
   * constraint. We scan the store for an existing `(kind: "main", repo)`
   * pair and return it instead of creating a duplicate. Two clones at
   * different paths (`/Users/x/kobe` vs `/tmp/kobe`) get separate main
   * tasks — they're separate repos by path, per the issue spec.
   *
   * Unarchive on re-add: if the user previously removed `repo` from
   * saved repos (which archives the main task) and is now re-adding it,
   * `ensureMainTask` flips `archived: false` so the row reappears in
   * Working session. Restoring without forcing the user to also press
   * `a` matches "remove + re-add" being the symmetric pair.
   *
   * Permission mode: the freshly-created main task lands with no pinned
   * `permissionMode` (CLI default). The user can still cycle it via
   * shift+tab. Existing main tasks aren't touched on re-ensure — we
   * don't override the user's stored choice across restarts.
   *
   * Boot-time seeding (in `app.tsx`) calls this for every entry in
   * `getSavedRepos()`. Order doesn't matter: each ensure is independent.
   */
  async ensureMainTask(repo: string): Promise<Task> {
    if (!repo) throw new Error("ensureMainTask: repo is required")
    const existing = this.store.list().find((t) => t.kind === "main" && t.repo === repo)
    if (existing) {
      // Re-add path: if the user previously removed this repo from saved
      // repos (which archives the main task) and is now re-adding it,
      // unarchive so the pinned row reappears in Working session.
      if (existing.archived) {
        return await this.store.update(existing.id, { archived: false })
      }
      return existing
    }
    const basename = repo.split("/").filter(Boolean).pop() ?? repo
    return await this.store.create({
      title: basename,
      repo,
      branch: "",
      worktreePath: repo,
      sessionId: null,
      status: "backlog",
      archived: false,
      kind: "main",
    })
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
    let info: Awaited<ReturnType<typeof this.worktrees.createForTask>>
    try {
      info = await this.worktrees.createForTask({
        repo: task.repo,
        taskId: task.id,
        branch,
        baseRef,
      })
    } catch (err) {
      // The raw `git worktree add` error is dense ("git worktree add
      // -b kobe/tmp-... <path> <baseRef> (cwd=<repo>) exited with
      // code 128: fatal: invalid reference: <baseRef>"). Boil it
      // down to one of a few user-actionable shapes so the chat
      // banner is short enough to read at a glance. The original is
      // still attached as `cause` for anyone who logs the full chain.
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(summarizeWorktreeError(message, task.repo, baseRef ?? null), { cause: err })
    }
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

    const slug = await this.metadataSuggester.suggestBranchSlug(prompt)
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
   * Replace the auto-derived sidebar title with a claude-suggested one
   * via a one-shot `claude -p` call. Runs in the background — failures
   * are swallowed.
   *
   * Skips the upgrade when the title isn't the truncate-derived form
   * of `prompt`: that means either an explicit title from createTask
   * or a manual rename via `r`, both of which we treat as load-bearing
   * user intent. Re-reads the task after the suggestion lands and
   * skips again if the title shifted while we were waiting (the user
   * renamed it mid-flight).
   */
  private async maybeUpgradeTitle(taskId: TaskId, prompt: string): Promise<void> {
    if (!prompt || prompt.trim().length === 0) return
    const task = this.store.get(taskId)
    if (!task) return
    const derived = deriveTitleFromPrompt(prompt)
    if (!derived) return
    // Only upgrade titles we ourselves wrote from this prompt. An
    // explicit createTask({title}) or sidebar `r` rename will land
    // here with task.title !== derived, and we leave it alone.
    if (task.title !== derived) return

    const suggested = await this.metadataSuggester.suggestTitle(prompt)
    if (!suggested) return
    if (suggested === derived) return

    const fresh = this.store.get(taskId)
    if (!fresh) return
    if (fresh.title !== derived) return // user renamed while we waited

    await this.store.update(taskId, { title: suggested })
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

    // KOB-15: main tasks are bound to the repo root checkout — no
    // `git worktree add`. Their `worktreePath === repo` is set by
    // `ensureMainTask`, so `ensureWorktree` is skipped entirely. The
    // engine cwd plumbing below already passes `task.worktreePath`,
    // which IS the repo root for main tasks; no special-case there.
    const isMain = task.kind === "main"
    // Lazy worktree: tasks created via the new-task dialog land here
    // with `worktreePath: ""`. Allocate it now (idempotent — returns
    // the task untouched if it already has a worktree). Main tasks
    // have a non-empty worktreePath from creation, so this branch is
    // skipped for them.
    const isFirstAllocation = !isMain && !task.worktreePath
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

    // Broadcast the user's prompt as a user.inject event BEFORE
    // touching the engine. Two reasons:
    //   1. Multi-attach correctness — the chat composer used to
    //      `pushUser(state, text)` locally, which meant other clients
    //      attached to the same daemon never received the user row.
    //      Going through dispatchEvent puts the user message on the
    //      same per-task event bus the daemon broadcasts to every
    //      attached TUI.
    //   2. Message-boundary correctness — the chat's assistant.delta
    //      reducer concatenates consecutive deltas into the most
    //      recent assistant row. Without a user row between two
    //      turns, the second response's deltas merge into the first
    //      assistant bubble. Emitting user.inject here re-anchors the
    //      conversation so the next assistant.delta starts a new row.
    // Blank prompts (the resume/continue path) intentionally skip the
    // dispatch — there's no user-visible message to inject. Note
    // requestPR and respondToInput previously dispatched user.inject
    // themselves; with this change those redundant dispatches are
    // removed so each user message hits the bus exactly once.
    if (prompt && prompt.trim().length > 0) {
      this.dispatchEvent(task.id, targetTab.id, { type: "user.inject", text: prompt })
    }

    // Model resolution: per-task pin → claude-code's
    // `~/.claude/settings.json` `model` key → kobe's hardcoded
    // FALLBACK_DEFAULT_MODEL_ID (opus 4.7 [1m]). Mirrors claude-code's
    // own getUserSpecifiedModelSetting() ordering. Doing the resolve
    // here (rather than passing `task.model` raw) means kobe's UI
    // label and the engine spawn agree on the same default.
    const modelToUse = task.model ?? resolveDefaultModelId()

    let handle: SessionHandle
    if (targetTab.sessionId) {
      handle = await this.engine.resume(targetTab.sessionId, promptToSend, {
        cwd: task.worktreePath,
        // Defensive duplicate: keep the env var alongside the typed
        // field for one release in case any external consumer (test
        // fixture, MCP bridge) still reads it. Remove in a follow-up
        // once we've confirmed nothing relies on it.
        env: { KOBE_RESUME_CWD: task.worktreePath },
        permissionMode: task.permissionMode,
        model: modelToUse,
      })
    } else {
      handle = await this.engine.spawn(task.worktreePath, promptToSend, {
        permissionMode: task.permissionMode,
        model: modelToUse,
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
      // Background: ask claude for a tighter sidebar title to replace
      // the truncate-derived one. Fire-and-forget; the rename method
      // bails out if the user manually rewrote the title in the
      // meantime, so this never stomps an explicit choice.
      if (prompt && prompt.trim().length > 0) {
        void this.maybeUpgradeTitle(task.id, prompt)
      }
    }
    this.handles.set(key, handle)
    this.bumpRunState()

    if (task.status !== "in_progress") {
      await this.store.update(task.id, { status: "in_progress" })
    }

    // Spin the pump. Captures `key` so the closure references the
    // right tab even if the user spawns more concurrently.
    const pump = this.runPumpAndCleanup(task.id, targetTab.id, handle)
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
    // PR injection always targets the task's currently-active tab
    // (the user pressed the button while looking at it). runTask
    // itself dispatches the user.inject — no need to do it twice.
    const activeTab = this.resolveTab(task)
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
    const resolved = this.pendingInputBroker.resolve(task.id, requestId)
    if (!resolved) return
    const pending = resolved.payload
    this.bumpRunState()

    // Tell the chat the row is no longer pending. Fire BEFORE runTask
    // so the approval banner flips to its final state in the same
    // render frame the synthetic user row appears.
    // Multi-tab caveat: pendingInput is keyed by taskId only (not
    // tabId) so we route the resolved event through the task's
    // active tab. In single-tab tasks this matches exactly; for
    // multi-tab, an approval surfaced from a non-active tab will
    // still resolve correctly but the chat banner update lands on
    // the active tab. Tightening this requires storing tabId in
    // pendingInput, which is a follow-up.
    const tabId = task.activeTabId
    this.dispatchEvent(task.id, tabId, { type: "user_input.resolved", requestId, response })

    const prompt = renderUserInputResponsePrompt(pending, response)
    if (!prompt) return
    // runTask itself dispatches the user.inject for the synthetic
    // prompt — no need to fire it explicitly here.
    await this.runTask(task.id, prompt, tabId)
  }

  /**
   * Interrupt the in-flight subprocess for one tab WITHOUT changing
   * task status — kobe's "steer" path. Maps to the user typing a new
   * prompt mid-stream and asking us to abandon the current generation
   * so the model can be redirected.
   *
   * Behaviour:
   *   - Kills the engine handle for `(taskId, tabId)`. The pump's
   *     `for await` loop ends, the pump's `finally` writes a terminal
   *     status (`in_review` or `error`) to the store, and the chat
   *     gets a `done`/`error` event.
   *   - Emits a dim `system.info` row so the user sees in the chat
   *     transcript that the turn was steered away from.
   *   - Does NOT clear the sessionId. The next `runTask` call that
   *     follows will `engine.resume(sessionId, ...)` and continue the
   *     conversation; claude-code's JSONL retains whatever partial
   *     assistant text was streamed before the kill, so the model
   *     sees the truncated prior turn as context for the new prompt.
   *
   * Idempotent: if the tab has no live handle (turn already ended,
   * tab was never started), this is a no-op.
   *
   * Distinct from {@link pauseTask}: pauseTask is task-level (stops
   * every tab) and demotes status to backlog. interruptTask is
   * tab-scoped and leaves status alone — the user is still actively
   * driving the task, they just want a different generation.
   */
  async interruptTask(id: TaskId | string, tabId?: string): Promise<void> {
    const task = this.requireTask(id)
    const targetTab = this.resolveTab(task, tabId)
    const key = tabKey(task.id, targetTab.id)
    const handle = this.handles.get(key)
    if (!handle) return // nothing to interrupt — no live pump
    // Surface the steer in the chat BEFORE killing the handle so the
    // user sees the row regardless of whether the kill emits its own
    // `done`/`error` event (it normally does, but the system.info row
    // is the human-readable affordance).
    this.dispatchEvent(task.id, targetTab.id, {
      type: "system.info",
      text: "(turn interrupted — sending new prompt)",
    })
    try {
      await this.engine.stop(handle)
    } finally {
      this.handles.delete(key)
      this.bumpRunState()
    }
    // engine.stop terminates the stream() iterator without yielding a
    // done/error event — the for-await in pumpEvents just returns. So
    // the pump never dispatches a terminal event and the chat reducer
    // keeps `isStreaming = true`, leaving the "thinking" / Harmonizing
    // indicator spinning forever after a bare ESC interrupt. Synthesize
    // a `done` here so the UI flips back to idle. For the steer flow
    // (interrupt + new prompt), the immediately-following runTask
    // emits user.inject which re-arms isStreaming — the false→true
    // flicker is the correct render: prior turn ended, new turn begins.
    this.dispatchEvent(task.id, targetTab.id, { type: "done" })
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
   * Toggle a regular task's pinned flag. Pinned regular tasks sort
   * above unpinned regular tasks in the sidebar's flat list (still
   * below `kind: "main"` rows). No-op on main rows — those are
   * implicitly pinned by virtue of being saved-repo bound. Pass
   * `pinned` explicitly to force a state, or omit to toggle.
   */
  async setPinned(id: TaskId | string, pinned?: boolean): Promise<void> {
    const task = this.requireTask(id)
    if (task.kind === "main") return
    const next = pinned ?? !task.pinned
    if ((task.pinned ?? false) === next) return
    await this.store.update(task.id, { pinned: next })
  }

  /**
   * Rename a single chat tab on a task. Persists `tabs[i].title` so
   * the chip in the center tab strip shows the user's label instead
   * of the auto-derived `chat N` fallback. Trims input and rejects
   * empty / whitespace-only — same shape as `setTitle`. Pass an empty
   * string after trim is a no-op-throw, not a "clear back to default";
   * if we want a clear-the-label verb later, add a sentinel arg.
   */
  async setTabTitle(id: TaskId | string, tabId: string, title: string): Promise<void> {
    const task = this.requireTask(id)
    const trimmed = typeof title === "string" ? title.trim() : ""
    if (trimmed.length === 0) {
      throw new Error("setTabTitle: title is required (empty or whitespace-only rejected)")
    }
    const idx = task.tabs.findIndex((t) => t.id === tabId)
    if (idx < 0) {
      throw new Error(`setTabTitle: tab ${tabId} not found on task ${task.id}`)
    }
    const current = task.tabs[idx]
    if (!current) return
    if (current.title === trimmed) return
    const nextTabs = task.tabs.map((t) => (t.id === tabId ? { ...t, title: trimmed } : t))
    await this.store.update(task.id, { tabs: nextTabs })
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

    // KOB-15: main tasks are bound to the user's actual repo checkout
    // (no kobe-allocated worktree). Refuse to delete them — the user
    // removes the repo from saved repos instead, which archives the
    // main task. The UI catches this error and surfaces the
    // "remove from saved repos" confirm copy.
    if (task.kind === "main") {
      throw new CannotDeleteMainTaskError()
    }

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
        this.bumpRunState()
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

    // Drop any pending-input entries still attributed to this task —
    // a delete mid-pause used to leak them into the broker forever.
    this.pendingInputBroker.clearForTask(task.id)

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
   * List every persisted Claude Code session for a task's worktree.
   *
   * Powers the resume-picker (`chat.session.resume`). The engine scans
   * `~/.claude/projects/<encoded-cwd>/*.jsonl` directly — kobe keeps no
   * parallel index, so a session opened by raw `claude --resume` outside
   * kobe still appears.
   *
   * Returns `[]` if the engine errors (so the picker shows a clean
   * "no sessions yet" state instead of a toast).
   */
  async listSessions(id: TaskId | string): Promise<SessionMeta[]> {
    const task = this.requireTask(id)
    if (!task.worktreePath) return []
    try {
      return await this.engine.listSessions(task.worktreePath)
    } catch {
      return []
    }
  }

  /**
   * Open `sessionId` in the chat shell as the active conversation.
   *
   * Behavior:
   *   - If the task already has a tab whose `sessionId` matches, just
   *     activate that tab. (No duplicate hydration; the existing tab
   *     already has the message history loaded.)
   *   - Otherwise, append a new tab whose `sessionId` is pre-seeded —
   *     done in a single `store.update` so Chat.tsx's reactive subscribe
   *     loop sees the tab with its sessionId set on first observation
   *     and fires `readHistory` automatically. (createTab→updateTab in
   *     two steps would race: the first observation would see
   *     sessionId=null and skip history hydration.)
   *
   * Returns the (existing or new) tab id so the UI can `setActiveTab`
   * after dismissing the picker dialog.
   */
  async openSessionInTab(id: TaskId | string, sessionId: string, opts: { title?: string } = {}): Promise<string> {
    const task = this.requireTask(id)
    const existing = task.tabs.find((t) => t.sessionId === sessionId)
    if (existing) {
      await this.setActiveTab(task.id, existing.id)
      return existing.id
    }
    const tab: ChatTab = {
      id: ulid(),
      sessionId,
      seq: nextChatTabSeq(task.tabs),
      createdAt: new Date().toISOString(),
      ...(opts.title ? { title: opts.title } : {}),
    }
    await this.store.update(task.id, { tabs: [...task.tabs, tab], activeTabId: tab.id })
    return tab.id
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
      seq: nextChatTabSeq(task.tabs),
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
      this.bumpRunState()
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
    this.bumpRunState()
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

  /**
   * Run the {@link SessionPump} for one (Task, ChatTab) handle and
   * then do the orchestrator-side bookkeeping the pump can't do for
   * itself: drop the handle from the registry, recompute the
   * run-state signal, write a terminal task status when every
   * sibling tab has stopped, and dispatch the buffered terminal
   * event downstream.
   *
   * Sequencing is load-bearing:
   *   1. handles.delete BEFORE the `stillLive` check — so the count
   *      reflects "still live siblings" not "including me."
   *   2. store.update(status) BEFORE the terminal-event dispatch —
   *      a chat subscriber reacting to `done` by queuing a follow-up
   *      `runTask` must see the post-terminal status, not the
   *      mid-rename state.
   *   3. handles.delete BEFORE bumpRunState — so the run-state map
   *      doesn't show this tab as running after it terminated.
   */
  private async runPumpAndCleanup(taskId: TaskId, tabId: string, handle: SessionHandle): Promise<void> {
    const key = tabKey(taskId, tabId)
    const { terminalEvent, killedForInput } = await this.sessionPump.run(taskId, tabId, handle)

    this.handles.delete(key)
    this.pumps.delete(key)
    this.bumpRunState()

    const terminal = terminalEvent?.type === "error" ? "error" : terminalEvent ? "done" : null
    if (terminal && !killedForInput) {
      // Only flip the task's status to a terminal value when ALL its
      // tabs have stopped. With multi-tab, a single tab finishing
      // doesn't mean the task is done — the user may still have other
      // tabs streaming.
      const stillLive = Array.from(this.handles.keys()).some((k) => k.startsWith(`${taskId}:`))
      if (!stillLive) {
        try {
          await this.store.update(taskId, { status: terminal === "done" ? "done" : "error" })
        } catch {
          /* store may have been cleared in tests; ignore */
        }
      }
    }

    // Dispatch the terminal event downstream. Subscribers reacting
    // to `done` now see the engine registry + store fully settled.
    if (terminalEvent && !killedForInput) {
      this.dispatchEvent(taskId, tabId, terminalEvent)
    }
    // killedForInput case: leave status as in_progress — the user is
    // about to answer and we'll resume via respondToInput → runTask.
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
