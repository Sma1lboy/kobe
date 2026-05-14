/** Orchestrator facade: public task API plus wiring between domain modules. */

import { type Accessor, createSignal } from "solid-js"
import type { RcBridgeStatus } from "../daemon/rc-bridge.ts"
import { type EngineMap, capabilitiesForModelId } from "../engine/registry.ts"
import type { SessionUsageMetrics } from "../session/usage-metrics.ts"
import type {
  AIEngine,
  BackgroundAgent,
  Message,
  ModelEffortLevel,
  OrchestratorEvent,
  SessionHandle,
  SessionMeta,
  UserInputResponse,
} from "../types/engine.ts"
import type { PendingInputBroker, PendingInputEntry } from "../types/pending-input-broker.ts"
import type { ChatTab, PermissionMode, Task, TaskId, VendorId } from "../types/task.ts"
import {
  clearChatTab,
  closeChatTab,
  createChatTab,
  openSessionInChatTab,
  resolveChatTab,
  setActiveChatTab,
  setChatTabTitle,
  updateChatTab,
} from "./chat-tabs.ts"
import { EngineRouter } from "./engine-routing.ts"
import {
  CONCURRENCY_CAP,
  CannotDeleteMainTaskError,
  ConcurrencyCapError,
  IllegalTransitionError,
  LocalMergePreconditionError,
  PRPreconditionError,
  TaskNotFoundError,
} from "./errors.ts"
import type { TaskIndexStore, TaskIndexUnsubscribe } from "./index/store.ts"
import { ulid } from "./index/ulid.ts"
import {
  DEFAULT_LOCAL_MERGE_INSTRUCTIONS_TEMPLATE,
  gatherLocalMergeState,
  renderLocalMergeInstructions,
} from "./local-merge/index.ts"
import { MetadataSuggester, type MetadataSuggestionContext } from "./metadata-suggester.ts"
import { InMemoryPendingInputBroker } from "./pending-input-broker.ts"
import { gatherPRState, loadPRInstructionsTemplate, renderPRInstructions } from "./pr/index.ts"
import { PLACEHOLDER_TASK_TITLE, TaskRunner } from "./run-task.ts"
import { SessionPump } from "./session-pump.ts"
import { TaskWorktreeCoordinator, summarizeWorktreeError } from "./task-worktree.ts"
import { deriveTitleFromPrompt } from "./title.ts"
import { renderUserInputResponsePrompt } from "./user-input.ts"
import type { GitWorktreeManager } from "./worktree/manager.ts"
export { TITLE_CHAR_CAP, deriveTitleFromPrompt } from "./title.ts"
export { PLACEHOLDER_TASK_TITLE } from "./run-task.ts"
export { summarizeWorktreeError } from "./task-worktree.ts"

export {
  CannotDeleteMainTaskError,
  CONCURRENCY_CAP,
  ConcurrencyCapError,
  IllegalTransitionError,
  LocalMergePreconditionError,
  PRPreconditionError,
  TaskNotFoundError,
} from "./errors.ts"

/** DI surface for the orchestrator. Tests pass test doubles here. */
export interface OrchestratorDeps {
  /**
   * Single engine (back-compat). When provided, the orchestrator
   * registers it under its declared `capabilities.vendorId` and uses
   * it as the fallback for any task whose vendor isn't separately
   * registered. Tests that don't care about routing keep using this.
   */
  readonly engine?: AIEngine
  /**
   * Vendor → engine map. When provided, takes precedence over
   * {@link engine}. Used by production bootstrap so codex/claude tasks
   * route to their own adapters. At least one of `engine` / `engines`
   * must be supplied — empty `engines` + no `engine` is rejected at
   * construction time.
   */
  readonly engines?: EngineMap
  readonly store: TaskIndexStore
  readonly worktrees: GitWorktreeManager
  /**
   * Optional override for the engine-driven metadata suggester
   * (branch slug today; worktree slug + title API exposed for
   * follow-ups). Tests inject a fake to avoid shelling out to
   * the selected engine. When omitted, the orchestrator constructs a default
   * instance. Construction is cheap; the engine is only touched when
   * the orchestrator asks for a suggestion.
   */
  readonly metadataSuggester?: MetadataSuggester
}

const TITLE_SUGGESTION_MIN_USER_TURNS = 3
/** Input to {@link Orchestrator.createTask}. */
export interface CreateTaskInput {
  readonly repo: string
  /** Optional first prompt used to derive the initial title. */
  readonly prompt?: string
  /** Explicit title override. */
  readonly title?: string
  /** Branch override; otherwise an auto branch is generated lazily. */
  readonly branch?: string
  /** Optional base ref for the new lazy worktree branch. */
  readonly baseRef?: string
  /** Optional initial model id for the task's first chat tab. */
  readonly model?: string
  /** Optional initial model effort for the task's first chat tab. */
  readonly modelEffort?: ModelEffortLevel
  /** Optional initial engine vendor for the task's first chat tab. */
  readonly vendor?: VendorId
}

/** Subscription teardown for {@link Orchestrator.subscribeEvents}. */
export type Unsubscribe = () => void

/** Live engine state for one chat tab. */
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
  private readonly engineRouter: EngineRouter
  private readonly store: TaskIndexStore
  private readonly worktrees: GitWorktreeManager
  private readonly metadataSuggester: MetadataSuggester
  private readonly worktreeCoordinator: TaskWorktreeCoordinator
  private readonly taskRunner: TaskRunner
  private readonly taskTitleCandidates = new Map<TaskId, { fallbackTitle: string }>()
  private readonly titleSuggestionUserPrompts = new Map<string, string[]>()
  private readonly titleSuggestionContexts = new Map<string, MetadataSuggestionContext>()
  private readonly titleSuggestionAttempted = new Set<TaskId>()
  private readonly titleSuggestionInFlight = new Set<TaskId>()
  private readonly pendingTitleTurnKeys = new Set<string>()
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
    this.store = deps.store
    this.engineRouter = new EngineRouter({
      engine: deps.engine,
      engines: deps.engines,
      store: deps.store,
      onTabVendorResolved: (taskId, tabId, vendor) => this.updateTab(taskId, tabId, { vendor }),
    })
    this.worktrees = deps.worktrees
    this.metadataSuggester = deps.metadataSuggester ?? new MetadataSuggester()
    this.worktreeCoordinator = new TaskWorktreeCoordinator({
      store: this.store,
      worktrees: this.worktrees,
      metadataSuggester: this.metadataSuggester,
      dispatchEvent: (taskId, tabId, ev) => this.dispatchEvent(taskId, tabId, ev),
    })
    this.taskRunner = new TaskRunner({
      store: this.store,
      handles: this.handles,
      pumps: this.pumps,
      worktrees: this.worktreeCoordinator,
      resolveTab: (task, tabId) => this.resolveTab(task, tabId),
      dispatchEvent: (taskId, tabId, ev) => this.dispatchEvent(taskId, tabId, ev),
      engineForTab: (task, tab) => this.engineForTab(task, tab),
      engineForTabRun: (task, tab) => this.engineForTabRun(task, tab),
      modelForTab: (task, tab, engine) => this.modelForTab(task, tab, engine),
      modelEffortForTab: (task, tab) => this.modelEffortForTab(task, tab),
      updateTab: (taskId, tabId, patch) => this.updateTab(taskId, tabId, patch),
      runPumpAndCleanup: (taskId, tabId, handle) => this.runPumpAndCleanup(taskId, tabId, handle),
      recordTitleSuggestionInput: (task, tab, prompt, context) =>
        this.recordTitleSuggestionInput(task, tab, prompt, context),
      bumpRunState: () => this.bumpRunState(),
    })
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
      engineFor: (taskId, tabId) => this.engineForTaskTabId(taskId as TaskId, tabId),
      broker: this.pendingInputBroker,
      dispatch: (taskId, tabId, ev) => this.dispatchEvent(taskId as TaskId, tabId, ev),
      nextRequestId: () => `req-${++this.requestIdCounter}`,
      onPendingInputChange: () => this.bumpRunState(),
    })
  }

  private engineForTask(task: Task): AIEngine {
    return this.engineRouter.engineForTask(task)
  }

  private vendorForTab(task: Task, tab: ChatTab): VendorId {
    return this.engineRouter.vendorForTab(task, tab)
  }

  private modelForTab(task: Task, tab: ChatTab, engine: AIEngine): string {
    return this.engineRouter.modelForTab(task, tab, engine)
  }

  private modelEffortForTab(task: Task, tab: ChatTab): ModelEffortLevel | undefined {
    return this.engineRouter.modelEffortForTab(task, tab)
  }

  private engineForTab(task: Task, tab: ChatTab): AIEngine {
    return this.engineRouter.engineForTab(task, tab)
  }

  private async engineForTabRun(task: Task, tab: ChatTab): Promise<AIEngine> {
    return this.engineRouter.engineForTabRun(task, tab)
  }

  private engineForTaskId(taskId: TaskId): AIEngine {
    return this.engineRouter.engineForTaskId(taskId)
  }

  private engineForTaskTabId(taskId: TaskId, tabId: string): AIEngine {
    return this.engineRouter.engineForTaskTabId(taskId, tabId)
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

  /**
   * Stub parity with {@link RemoteOrchestrator.planUsageSignal} — the
   * in-process Orchestrator does not poll Claude plan utilization
   * (that's a daemon responsibility, see `daemon/plan-usage-poller.ts`).
   * Returns a permanently-null accessor so the WORKSPACE topbar wiring
   * in `tui/app.tsx` can read it unconditionally without an
   * `instanceof` narrowing.
   */
  planUsageSignal(): Accessor<null> {
    return () => null
  }

  /**
   * Stub parity with {@link RemoteOrchestrator.rcBridgeSignal} — the
   * in-process Orchestrator never spawns the `claude remote-control`
   * bridge (that's a daemon-owned side process; see
   * `daemon/rc-bridge.ts`). Returns a permanently-"off" accessor so
   * the TopBar chip / share dialog wiring can read this unconditionally
   * without `instanceof` narrowing. The TUI gates the dialog opener
   * itself on `orchestrator instanceof RemoteOrchestrator`.
   */
  rcBridgeSignal(): Accessor<RcBridgeStatus> {
    return () => ({ state: "off" })
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
  peekPendingInput(id: TaskId | string): PendingInputEntry[] {
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
      model: input.model,
      modelEffort: input.modelEffort,
      vendor: input.vendor,
    })
    // Branch is allocated lazily so the auto-name's ulid suffix uses
    // the real task id (computing it before `store.create` would slug
    // an empty suffix). Persist only the user's explicit override (if
    // any) and baseRef; ensureWorktree re-derives auto names.
    this.worktreeCoordinator.registerPendingWorktreeOpts(created.id, {
      branch: input.branch,
      baseRef: input.baseRef,
    })
    return created
  }

  async ensureMainTask(repo: string): Promise<Task> {
    return await this.worktreeCoordinator.ensureMainTask(repo)
  }

  async runTask(id: TaskId | string, prompt?: string, tabId?: string): Promise<void> {
    await this.taskRunner.runTask(this.requireTask(id), prompt, tabId)
  }

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
   * Start the local-merge flow for a task.
   *
   * This is the local counterpart to {@link requestPR}: kobe does not run
   * `git merge` itself. It creates a dedicated "Merge" ChatTab, inherits the
   * active tab's engine/model configuration through {@link createTab}, switches
   * that tab active, and injects a prompt that tells the agent to merge the
   * task worktree into the parent repo checkout (`task.repo`).
   */
  async requestLocalMerge(id: TaskId | string): Promise<void> {
    const task = this.requireTask(id)
    if (task.kind === "main") {
      throw new LocalMergePreconditionError("Main repo rows are already the merge target.")
    }
    if (task.status === "canceled") {
      throw new LocalMergePreconditionError("Cannot local-merge a canceled task.")
    }
    if (!task.worktreePath) {
      throw new LocalMergePreconditionError("Task has no worktree yet — send a first prompt before merging.")
    }
    if (!task.repo) {
      throw new LocalMergePreconditionError("Task has no parent repo path; cannot resolve local merge target.")
    }

    const state = await gatherLocalMergeState(task)
    const prompt = renderLocalMergeInstructions(DEFAULT_LOCAL_MERGE_INSTRUCTIONS_TEMPLATE, state)
    const mergeTab = await this.createTab(task.id, { title: "Merge" })
    await this.setActiveTab(task.id, mergeTab.id)
    await this.runTask(task.id, prompt, mergeTab.id)
  }

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
      await this.engineForTask(task).stop(handle)
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

  async steerTask(id: TaskId | string, prompt: string, tabId?: string): Promise<void> {
    const task = this.requireTask(id)
    const targetTab = this.resolveTab(task, tabId)
    await this.interruptTask(task.id, targetTab.id)
    await this.runTask(task.id, prompt, targetTab.id)
  }

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

  async archiveTask(id: TaskId | string, status: "done" | "canceled"): Promise<void> {
    const task = this.requireTask(id)
    if (status !== "done" && status !== "canceled") {
      throw new IllegalTransitionError(task.status, status, String(id))
    }
    await this.stopAllTabsForTask(task.id)
    await this.store.archive(task.id, status)
  }

  async setArchived(id: TaskId | string, archived?: boolean): Promise<void> {
    const task = this.requireTask(id)
    const next = archived ?? !task.archived
    if (task.archived === next) return
    await this.store.update(task.id, { archived: next })
  }

  async setPermissionMode(id: TaskId | string, mode: PermissionMode | undefined): Promise<void> {
    const task = this.requireTask(id)
    if (task.permissionMode === mode) return
    await this.store.update(task.id, { permissionMode: mode })
  }

  async setModel(
    id: TaskId | string,
    model: string | undefined,
    tabId?: string,
    modelEffort?: ModelEffortLevel,
  ): Promise<void> {
    const task = this.requireTask(id)
    const tab = this.resolveTab(task, tabId)
    // Derive the vendor from the picked model so a codex pick routes
    // the next runTask through the codex engine. When `model` is
    // cleared (undefined), the vendor stays put — clearing means "use
    // this vendor's default model," not "switch back to claude."
    const vendor = model ? capabilitiesForModelId(model).vendorId : this.vendorForTab(task, tab)
    const currentVendor = this.vendorForTab(task, tab)
    if (tab.sessionId && vendor !== currentVendor) {
      throw new Error("setModel: cannot switch engine for a started chat tab; create a new chat tab")
    }
    if (tab.model === model && tab.modelEffort === modelEffort && currentVendor === vendor) return
    await this.updateTab(task.id, tab.id, { model, modelEffort, vendor })
  }

  async setTitle(id: TaskId | string, title: string): Promise<void> {
    const task = this.requireTask(id)
    const trimmed = typeof title === "string" ? title.trim() : ""
    if (trimmed.length === 0) {
      throw new Error("setTitle: title is required (empty or whitespace-only rejected)")
    }
    if (task.title === trimmed) return
    await this.store.update(task.id, { title: trimmed })
    this.taskTitleCandidates.delete(task.id)
    this.titleSuggestionAttempted.add(task.id)
  }

  private recordTitleSuggestionInput(
    task: Task,
    tab: ChatTab,
    prompt: string | undefined,
    context: MetadataSuggestionContext,
  ): void {
    const trimmed = prompt?.trim()
    if (!trimmed) return
    const key = tabKey(task.id, tab.id)
    const prompts = this.titleSuggestionUserPrompts.get(key) ?? []
    prompts.push(trimmed)
    this.titleSuggestionUserPrompts.set(key, prompts)
    this.titleSuggestionContexts.set(key, context)
    this.pendingTitleTurnKeys.add(key)

    if (this.taskTitleCandidates.has(task.id)) return
    if (tab.sessionId) return
    const fallbackTitle = deriveTitleFromPrompt(trimmed)
    if (!fallbackTitle) return
    if (task.title === PLACEHOLDER_TASK_TITLE || task.title === fallbackTitle) {
      this.taskTitleCandidates.set(task.id, { fallbackTitle })
    }
  }

  private clearTitleSuggestionTab(taskId: TaskId, tabId: string): void {
    const key = tabKey(taskId, tabId)
    this.titleSuggestionUserPrompts.delete(key)
    this.titleSuggestionContexts.delete(key)
    this.pendingTitleTurnKeys.delete(key)
  }

  private clearTitleSuggestionTask(taskId: TaskId): void {
    this.taskTitleCandidates.delete(taskId)
    this.titleSuggestionAttempted.delete(taskId)
    this.titleSuggestionInFlight.delete(taskId)
    for (const key of this.titleSuggestionUserPrompts.keys()) {
      if (key.startsWith(`${taskId}:`)) {
        this.titleSuggestionUserPrompts.delete(key)
        this.titleSuggestionContexts.delete(key)
        this.pendingTitleTurnKeys.delete(key)
      }
    }
  }

  private async maybeUpgradeTitleAfterEnoughTurns(taskId: TaskId, tabId: string): Promise<void> {
    if (this.titleSuggestionAttempted.has(taskId) || this.titleSuggestionInFlight.has(taskId)) return
    const key = tabKey(taskId, tabId)
    const prompts = this.titleSuggestionUserPrompts.get(key) ?? []
    if (prompts.length < TITLE_SUGGESTION_MIN_USER_TURNS) return
    const candidate = this.taskTitleCandidates.get(taskId)
    const context = this.titleSuggestionContexts.get(key)
    const task = this.store.get(taskId)
    if (!candidate || !context || !task) return
    if (task.title !== candidate.fallbackTitle) return

    this.titleSuggestionAttempted.add(taskId)
    this.titleSuggestionInFlight.add(taskId)
    try {
      const suggested = await this.metadataSuggester.suggestTitle(buildFeatureTitlePrompt(prompts), context)
      if (!suggested || suggested === candidate.fallbackTitle) return
      const fresh = this.store.get(taskId)
      if (!fresh) return
      if (fresh.title !== candidate.fallbackTitle) return
      await this.store.update(taskId, { title: suggested })
    } finally {
      this.titleSuggestionInFlight.delete(taskId)
    }
  }

  async setPinned(id: TaskId | string, pinned?: boolean): Promise<void> {
    const task = this.requireTask(id)
    if (task.kind === "main") return
    const next = pinned ?? !task.pinned
    if ((task.pinned ?? false) === next) return
    await this.store.update(task.id, { pinned: next })
  }

  async setTabTitle(id: TaskId | string, tabId: string, title: string): Promise<void> {
    const task = this.requireTask(id)
    await setChatTabTitle(this.store, task, tabId, title)
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
        await this.engineForTask(task).deleteHistory(task.sessionId)
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
    this.clearTitleSuggestionTask(task.id)

    await this.store.remove(task.id)
  }

  async readHistory(sessionId: string): Promise<Message[]> {
    return this.engineRouter.readHistory(sessionId)
  }

  async readHistoryWithMetrics(
    sessionId: string,
  ): Promise<{ messages: Message[]; usageMetrics?: SessionUsageMetrics }> {
    return this.engineRouter.readHistoryWithMetrics(sessionId)
  }

  async listSessions(id: TaskId | string): Promise<SessionMeta[]> {
    const task = this.requireTask(id)
    const tab = this.resolveTab(task)
    return this.engineRouter.listSessions(task, tab)
  }

  async listBackgroundAgents(id: TaskId | string): Promise<BackgroundAgent[]> {
    const task = this.requireTask(id)
    const tab = this.resolveTab(task)
    return this.engineRouter.listBackgroundAgents(task, tab)
  }

  async openSessionInTab(
    id: TaskId | string,
    sessionId: string,
    opts: { title?: string; vendor?: VendorId } = {},
  ): Promise<string> {
    const task = this.requireTask(id)
    return await openSessionInChatTab(this.chatTabDeps(), task, sessionId, opts)
  }

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

  async createTab(id: TaskId | string, opts: { title?: string } = {}): Promise<ChatTab> {
    const task = this.requireTask(id)
    return await createChatTab(this.chatTabDeps(), task, opts)
  }

  async clearTab(id: TaskId | string, tabId: string): Promise<void> {
    const task = this.requireTask(id)
    await clearChatTab(this.chatTabDeps(), task, tabId)
    this.clearTitleSuggestionTab(task.id as TaskId, tabId)
  }

  async closeTab(id: TaskId | string, tabId: string): Promise<string> {
    const task = this.requireTask(id)
    const nextActive = await closeChatTab(this.chatTabDeps(), task, tabId)
    this.clearTitleSuggestionTab(task.id, tabId)
    return nextActive
  }

  async setActiveTab(id: TaskId | string, tabId: string): Promise<void> {
    const task = this.requireTask(id)
    await setActiveChatTab(this.store, task, tabId)
  }

  async _waitForPumpsIdle(): Promise<void> {
    const pumps = Array.from(this.pumps.values())
    await Promise.allSettled(pumps)
  }

  // ---------- internals ----------

  private chatTabDeps() {
    return {
      store: this.store,
      createId: () => ulid(),
      nowIso: () => new Date().toISOString(),
      vendorForTab: (task: Task, tab: ChatTab) => this.vendorForTab(task, tab),
      stopTab: (taskId: TaskId, tabId: string) => this.stopTab(taskId, tabId),
      dispatchEvent: (taskId: TaskId, tabId: string, ev: OrchestratorEvent) => this.dispatchEvent(taskId, tabId, ev),
    }
  }

  private requireTask(id: TaskId | string): Task {
    const task = this.store.get(id)
    if (!task) throw new TaskNotFoundError(String(id))
    return task
  }

  private resolveTab(task: Task, tabId?: string): ChatTab {
    return resolveChatTab(task, tabId)
  }

  private async updateTab(taskId: TaskId, tabId: string, patch: Partial<ChatTab>): Promise<void> {
    await updateChatTab(this.store, taskId, tabId, patch)
  }

  private async stopTab(taskId: TaskId, tabId: string): Promise<void> {
    const key = tabKey(taskId, tabId)
    const handle = this.handles.get(key)
    if (!handle) return
    try {
      await this.engineForTaskId(taskId).stop(handle)
    } finally {
      this.handles.delete(key)
      this.bumpRunState()
    }
  }

  private async stopAllTabsForTask(taskId: TaskId): Promise<void> {
    const prefix = `${taskId}:`
    const keys = Array.from(this.handles.keys()).filter((k) => k.startsWith(prefix))
    const engine = this.engineForTaskId(taskId)
    for (const key of keys) {
      const handle = this.handles.get(key)
      if (!handle) continue
      try {
        await engine.stop(handle)
      } catch {
        // Best-effort; the lifecycle method that called us will surface
        // task-level state regardless.
      }
      this.handles.delete(key)
    }
    this.bumpRunState()
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
    if (terminalEvent?.type === "done" && !killedForInput && this.pendingTitleTurnKeys.delete(key)) {
      await this.maybeUpgradeTitleAfterEnoughTurns(taskId, tabId)
    }
    // killedForInput case: leave status as in_progress — the user is
    // about to answer and we'll resume via respondToInput → runTask.
  }
}

function buildFeatureTitlePrompt(prompts: readonly string[]): string {
  const lines = prompts.slice(0, TITLE_SUGGESTION_MIN_USER_TURNS).map((prompt, i) => {
    const collapsed = prompt.replace(/\s+/g, " ").trim()
    return `${i + 1}. ${collapsed}`
  })
  return ["Conversation user messages:", ...lines].join("\n")
}
