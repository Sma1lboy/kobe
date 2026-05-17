import { type Accessor, createSignal } from "solid-js"
import type { RcBridgeStatus } from "../daemon/rc-bridge.ts"
import { type ChatRunState, type Orchestrator, type Unsubscribe, chatRunStateKey } from "../orchestrator/core.ts"
import { InMemoryPendingInputBroker } from "../orchestrator/pending-input-broker.ts"
import type { SessionUsageMetrics } from "../session/usage-metrics.ts"
import type {
  EngineCommandEntry,
  Message,
  ModelEffortLevel,
  OrchestratorEvent,
  PermissionMode,
  SessionMeta,
  UserInputResponse,
} from "../types/engine.ts"
import type { PendingInputBroker, PendingInputEntry } from "../types/pending-input-broker.ts"
import type { PlanUsage } from "../types/plan-usage.ts"
import type { ChatTab, Task, VendorId } from "../types/task.ts"
import { ensureDaemonReachable } from "./daemon-process.ts"
import type { KobeDaemonClient } from "./index.ts"

type PendingInput = PendingInputEntry
export type KobeOrchestrator = Orchestrator | RemoteOrchestrator

/**
 * Daemon connection lifecycle as observed by the TUI. Two states because
 * reconnect is user-driven (the host shows a "Restart daemon or Quit?"
 * prompt when we go `disconnected`); no auto-retry, no intermediate
 * "reconnecting" state.
 *
 * Surfaced via {@link RemoteOrchestrator.connectionStateSignal} so the
 * top bar and the disconnect modal can react. The local in-process
 * `Orchestrator` has no equivalent — there's no socket to lose.
 */
export type DaemonConnectionState = "online" | "disconnected"

export interface RemoteOrchestratorOptions {
  /**
   * Bring the daemon back on the socket this client already points at.
   * Shared mode uses the stable production socket; single/owned mode
   * injects a restart function for its per-TUI socket.
   */
  readonly ensureReachable?: () => Promise<unknown>
}

export class RemoteOrchestrator {
  private readonly tasksAcc: Accessor<Task[]>
  private readonly setTasks: (next: Task[]) => void
  private readonly runStateAcc: Accessor<ReadonlyMap<string, ChatRunState>>
  private readonly setRunState: (next: ReadonlyMap<string, ChatRunState>) => void
  private readonly planUsageAcc: Accessor<PlanUsage | null>
  private readonly setPlanUsage: (next: PlanUsage | null) => void
  private readonly connectionStateAcc: Accessor<DaemonConnectionState>
  private readonly setConnectionState: (next: DaemonConnectionState) => void
  private readonly rcBridgeAcc: Accessor<RcBridgeStatus>
  private readonly setRcBridge: (next: RcBridgeStatus) => void
  private readonly ensureReachable: () => Promise<unknown>
  private readonly subscribers = new Map<string, Set<(ev: OrchestratorEvent) => void>>()
  /**
   * Wire-fed replica of the daemon's pending-input bucket. Same
   * adapter as the local Orchestrator uses — see
   * `src/types/pending-input-broker.ts` for the seam rationale. Filled
   * on `init()` via `chat.input.pending` per task, then maintained
   * forward by listening to `user_input.request` / `user_input.resolved`
   * wire events.
   *
   * Each wire snapshot entry carries its own `tabKey`, so hydration
   * attributes pause requests to the tab that actually fired them —
   * not the task's currently-active tab. That difference matters for
   * pause requests fired against a non-active tab, where the old
   * `activeTabId` fallback misrouted the awaiting-input dot.
   */
  private readonly pendingInputBroker: PendingInputBroker = new InMemoryPendingInputBroker()

  constructor(
    private readonly client: KobeDaemonClient,
    options: RemoteOrchestratorOptions = {},
  ) {
    const [tasks, setTasks] = createSignal<Task[]>([])
    const [runState, setRunState] = createSignal<ReadonlyMap<string, ChatRunState>>(new Map())
    const [planUsage, setPlanUsage] = createSignal<PlanUsage | null>(null)
    const [connectionState, setConnectionState] = createSignal<DaemonConnectionState>("online")
    const [rcBridge, setRcBridge] = createSignal<RcBridgeStatus>({ state: "off" })
    this.tasksAcc = tasks
    this.setTasks = (next) => setTasks(() => next)
    this.runStateAcc = runState
    this.setRunState = (next) => setRunState(() => next)
    this.planUsageAcc = planUsage
    this.setPlanUsage = (next) => setPlanUsage(() => next)
    this.connectionStateAcc = connectionState
    this.setConnectionState = (next) => setConnectionState(() => next)
    this.rcBridgeAcc = rcBridge
    this.setRcBridge = (next) => setRcBridge(() => next)
    this.ensureReachable = options.ensureReachable ?? ensureDaemonReachable
    this.client.on("*", (frame) => this.handleEvent(frame.name, frame.payload))
    // KOB-38: socket dropping flips us to `disconnected` and stops
    // there. The host TUI watches this signal, shows a modal, and the
    // user picks Restart (→ `manualReconnect`) or Quit. No backoff
    // loop, no banner-only state — daemon death is rare and never
    // transient, so a user-driven prompt fits the actual flake pattern.
    this.client.onLifecycle("close", () => this.setConnectionState("disconnected"))
  }

  async init(): Promise<void> {
    // `hello` now returns tasks + pending-input snapshots inline so a
    // fresh attach is two round-trips (hello + subscribe) instead of
    // 2 + N. Old daemons that don't echo `tasks`/`pending` fall back
    // to the legacy `task.list` + per-task `chat.input.pending` path.
    const hello = await this.client.request<{
      tasks?: Task[]
      pending?: Record<string, PendingInput[]>
      runState?: Record<string, ChatRunState>
      planUsage?: PlanUsage | null
      rcBridge?: RcBridgeStatus
    }>("hello", { clientId: `tui-${process.pid}`, version: "1" })

    let tasks: Task[]
    if (hello.tasks) {
      tasks = hello.tasks
    } else {
      const res = await this.client.request<{ tasks: Task[] }>("task.list")
      tasks = res.tasks
    }
    this.setTasks(tasks)
    // Seed run-state from the hello snapshot so reconnecting onto a
    // daemon mid-stream repaints the green/yellow tab dot immediately
    // instead of waiting for the next event to flow through.
    if (hello.runState) {
      const seed = new Map<string, ChatRunState>()
      for (const [key, value] of Object.entries(hello.runState)) seed.set(key, value)
      if (seed.size > 0) this.setRunState(seed)
    }
    if (hello.planUsage) this.setPlanUsage(hello.planUsage)
    if (hello.rcBridge) this.setRcBridge(hello.rcBridge)
    await this.client.request("subscribe", { taskIds: "all" })

    if (hello.pending) {
      for (const [taskId, entries] of Object.entries(hello.pending)) {
        for (const entry of entries) {
          this.pendingInputBroker.record(taskId, entry.tabKey, entry.requestId, entry.payload)
        }
      }
      return
    }

    // Legacy fallback: ask each task individually. Run in parallel;
    // per-task failures are non-fatal — worst case the composer
    // doesn't lock until the next user_input.request arrives.
    await Promise.all(
      tasks.map(async (task) => {
        try {
          const pending = await this.client.request<{ pending: PendingInput[] }>("chat.input.pending", {
            taskId: task.id,
          })
          for (const entry of pending.pending) {
            this.pendingInputBroker.record(task.id, entry.tabKey, entry.requestId, entry.payload)
          }
        } catch {
          /* per-task hydration is best-effort */
        }
      }),
    )
  }

  /**
   * KOB-38: invoked by the host TUI when the user clicks "Restart" in
   * the disconnect modal. Spawns the daemon if it isn't already running,
   * opens a fresh socket on the existing client, then runs the same
   * hello + subscribe seeding as {@link init} — pending-input replicas
   * for previously-known tasks are cleared first so a request resolved
   * while we were offline doesn't stick as a zombie "awaiting input".
   *
   * Throws if the daemon can't be brought up or hello/subscribe fail;
   * caller (the modal) is expected to surface the error and re-prompt.
   */
  async manualReconnect(): Promise<void> {
    // Make sure any half-open socket is torn down before we try to
    // reuse the client — otherwise `connect()` short-circuits on a
    // dead socket reference.
    this.client.forceDisconnect()
    await this.ensureReachable()
    for (const task of this.tasksAcc()) this.pendingInputBroker.clearForTask(task.id)
    await this.init()
    this.setConnectionState("online")
  }

  /** Reactive accessor for the daemon connection state — read by the
   *  TopBar (red text when disconnected) and the disconnect modal. */
  connectionStateSignal(): Accessor<DaemonConnectionState> {
    return this.connectionStateAcc
  }

  dispose(): void {
    this.client.close()
  }

  tasksSignal(): Accessor<Task[]> {
    return this.tasksAcc
  }

  chatRunStateSignal(): Accessor<ReadonlyMap<string, ChatRunState>> {
    return this.runStateAcc
  }

  /**
   * Latest Claude plan-usage snapshot broadcast by the daemon. Returns
   * `null` until the daemon has fetched at least once (or always, if the
   * user isn't signed into claude-code). The WORKSPACE topbar reads this
   * to render the `Plan 5h … · 7d …` chip alongside the context meter.
   */
  planUsageSignal(): Accessor<PlanUsage | null> {
    return this.planUsageAcc
  }

  /**
   * Latest remote-control bridge status broadcast by the daemon. Hydrated
   * from `hello` snapshot, then updated by `rcBridge.changed` events.
   * Defaults to `{ state: "off" }` until the daemon answers `hello`.
   */
  rcBridgeSignal(): Accessor<RcBridgeStatus> {
    return this.rcBridgeAcc
  }

  /**
   * Start the remote-control bridge. When `taskId` is supplied the
   * daemon binds the bridge to that task's worktree (and to the
   * specific tab when `tabId` is also given) so the dialog can show
   * a `/resume <sid>` hint. Without `taskId` the daemon falls back
   * to its own process cwd's git toplevel — useful for daemon
   * installations that aren't task-anchored, but the dialog won't
   * surface a session-resume hint.
   */
  async startRcBridge(opts: { taskId?: string; tabId?: string; cwd?: string } = {}): Promise<RcBridgeStatus> {
    const res = await this.client.request<{ status: RcBridgeStatus }>("rcBridge.start", {
      taskId: opts.taskId,
      tabId: opts.tabId,
      cwd: opts.cwd,
    })
    return res.status
  }

  async stopRcBridge(): Promise<RcBridgeStatus> {
    const res = await this.client.request<{ status: RcBridgeStatus }>("rcBridge.stop", {})
    return res.status
  }

  listTasks(): Task[] {
    return this.tasksAcc().slice()
  }

  getTask(id: string): Task | undefined {
    return this.tasksAcc().find((t) => t.id === id)
  }

  async createTask(input: {
    repo: string
    prompt?: string
    title?: string
    branch?: string
    baseRef?: string
    model?: string
    modelEffort?: ModelEffortLevel
    vendor?: VendorId
  }): Promise<Task> {
    const res = await this.client.request<{ task: Task }>("task.spawn", input)
    return res.task
  }

  async ensureMainTask(repo: string): Promise<Task> {
    const res = await this.client.request<{ task: Task }>("task.ensureMain", { repo })
    return res.task
  }

  async runTask(taskId: string, text?: string, tabId?: string): Promise<void> {
    // Pass `text` through as-is. The daemon's chat.send accepts undefined
    // for "continue/resume without a new prompt"; the previous `text ?? " "`
    // sentinel was there to dodge a server-side requireString check that
    // no longer exists.
    await this.client.request("chat.send", { taskId, text, tabId })
    this.markRunState(taskId, tabId ?? this.getTask(taskId)?.activeTabId, "running")
  }

  async interruptTask(taskId: string, tabId?: string): Promise<void> {
    await this.client.request("chat.interrupt", { taskId, tabId })
  }

  async steerTask(taskId: string, text: string, tabId?: string): Promise<void> {
    await this.client.request("chat.steer", { taskId, text, tabId })
    this.markRunState(taskId, tabId ?? this.getTask(taskId)?.activeTabId, "running")
  }

  async setArchived(taskId: string, archived?: boolean): Promise<void> {
    await this.client.request("task.archive", { taskId, archived })
  }

  async setPinned(taskId: string, pinned?: boolean): Promise<void> {
    await this.client.request("task.pin", { taskId, pinned })
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.client.request("task.delete", { taskId })
  }

  async setTitle(taskId: string, title: string): Promise<void> {
    await this.client.request("task.rename", { taskId, title })
  }

  async setTabTitle(taskId: string, tabId: string, title: string): Promise<void> {
    await this.client.request("chat.tab.rename", { taskId, tabId, title })
  }

  async setPermissionMode(taskId: string, mode: PermissionMode | undefined): Promise<void> {
    await this.client.request("task.permissionMode", { taskId, mode })
  }

  async setModel(
    taskId: string,
    model: string | undefined,
    tabId?: string,
    modelEffort?: ModelEffortLevel,
    vendor?: VendorId,
  ): Promise<void> {
    await this.client.request("task.model", { taskId, model, tabId, modelEffort, vendor })
  }

  async createTab(taskId: string, opts: { title?: string } = {}): Promise<ChatTab> {
    const res = await this.client.request<{ tab: ChatTab }>("chat.tab.create", { taskId, title: opts.title })
    return res.tab
  }

  async closeTab(taskId: string, tabId: string): Promise<string> {
    const res = await this.client.request<{ nextActive: string }>("chat.tab.close", { taskId, tabId })
    return res.nextActive
  }

  async clearTab(taskId: string, tabId: string): Promise<void> {
    await this.client.request("chat.tab.clear", { taskId, tabId })
  }

  async setActiveTab(taskId: string, tabId: string): Promise<void> {
    await this.client.request("chat.tab.activate", { taskId, tabId })
  }

  async readHistory(sessionId: string): Promise<Message[]> {
    return (await this.readHistoryWithMetrics(sessionId)).messages
  }

  async readHistoryWithMetrics(
    sessionId: string,
  ): Promise<{ messages: Message[]; usageMetrics?: SessionUsageMetrics }> {
    const task = this.tasksAcc().find(
      (t) => t.sessionId === sessionId || t.tabs.some((tab) => tab.sessionId === sessionId),
    )
    if (!task) return { messages: [] }
    // Pass the requested sessionId through to the daemon so it returns
    // history for the specific tab the caller asked about, not the
    // task's currently-active tab. Without this, Chat's per-tab
    // hydration runs N times for the same active-tab transcript and
    // every tab ends up rendering identical content.
    const res = await this.client.request<{ messages: Message[]; usageMetrics?: SessionUsageMetrics }>("chat.history", {
      taskId: task.id,
      sessionId,
      limit: 500,
    })
    return {
      messages: res.messages,
      ...(res.usageMetrics ? { usageMetrics: res.usageMetrics } : {}),
    }
  }

  async listSessions(taskId: string): Promise<SessionMeta[]> {
    const res = await this.client.request<{ sessions: SessionMeta[] }>("chat.sessions", { taskId })
    return res.sessions
  }

  async listCommandsForTab(taskId: string, tabId: string): Promise<readonly EngineCommandEntry[]> {
    const res = await this.client.request<{ commands: EngineCommandEntry[] }>("chat.commands", { taskId, tabId })
    return res.commands
  }

  async openSessionInTab(
    taskId: string,
    sessionId: string,
    opts: { title?: string; vendor?: SessionMeta["vendor"] } = {},
  ): Promise<string> {
    const res = await this.client.request<{ tabId: string }>("chat.session.open", {
      taskId,
      sessionId,
      title: opts.title,
      vendor: opts.vendor,
    })
    return res.tabId
  }

  subscribeEvents(taskId: string, cb: (ev: OrchestratorEvent) => void, tabId?: string): Unsubscribe {
    const resolvedTabId = tabId ?? this.getTask(taskId)?.activeTabId ?? taskId
    const key = `${taskId}:${resolvedTabId}`
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

  async requestPR(taskId: string): Promise<void> {
    await this.client.request("pr.request", { taskId })
  }

  async refreshPRStatus(taskId: string): Promise<void> {
    await this.client.request("pr.status.refresh", { taskId })
  }

  async requestPRMerge(taskId: string): Promise<void> {
    await this.client.request("pr.merge.request", { taskId })
  }

  async requestLocalMerge(taskId: string): Promise<void> {
    await this.client.request("merge.local.request", { taskId })
  }

  /**
   * Ask the daemon to shut itself down. Used by the Settings → Dev
   * "Restart backend" button so the user can pick up daemon-side code
   * edits without a process kill. After this resolves the socket
   * closes; the caller is expected to quit the TUI so the next
   * relaunch's `connectOrStartDaemon` spawns a fresh daemon with the
   * new code in memory.
   *
   * Only exists on RemoteOrchestrator — the in-process local
   * Orchestrator has no daemon to stop. SettingsDialog narrows on
   * `instanceof RemoteOrchestrator` before showing the button.
   */
  async stopDaemon(): Promise<void> {
    await this.client.request("daemon.stop")
  }

  async respondToInput(taskId: string, requestId: string, response: UserInputResponse): Promise<void> {
    await this.client.request("chat.input.respond", { taskId, requestId, response })
  }

  peekPendingInput(taskId: string): PendingInput[] {
    return this.pendingInputBroker.snapshot(taskId)
  }

  private handleEvent(name: string, payload: unknown): void {
    const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}
    if (name === "task.snapshot") {
      this.setTasks(((obj.tasks as Task[] | undefined) ?? []).slice())
      return
    }
    if (name === "task.created") {
      const task = obj.task as Task | undefined
      if (task) this.upsertTask(task)
      return
    }
    if (name === "task.updated") {
      const task = obj.task as Task | undefined
      if (task) this.upsertTask(task)
      return
    }
    if (name === "task.deleted") {
      const taskId = obj.taskId as string | undefined
      if (taskId) {
        this.setTasks(this.tasksAcc().filter((t) => t.id !== taskId))
        this.pendingInputBroker.clearForTask(taskId)
      }
      return
    }
    if (name === "plan.usage") {
      const usage = obj.usage as PlanUsage | null | undefined
      this.setPlanUsage(usage ?? null)
      return
    }
    if (name === "rcBridge.changed") {
      const status = obj.status as RcBridgeStatus | undefined
      if (status) this.setRcBridge(status)
      return
    }
    const taskId = obj.taskId as string | undefined
    const tabId = obj.tabId as string | undefined
    if (!taskId || !tabId) return
    if (name === "chat.delta") {
      this.dispatch(taskId, tabId, { type: "assistant.delta", text: String(obj.delta ?? "") })
      return
    }
    if (name === "chat.complete") {
      this.clearRunState(taskId, tabId)
      this.dispatch(taskId, tabId, { type: "done" })
      return
    }
    if (name === "engine.status") {
      const status = obj.status
      if (status === "running") this.markRunState(taskId, tabId, "running")
      if (status === "error" || status === "offline") this.clearRunState(taskId, tabId)
      if (status === "error")
        this.dispatch(taskId, tabId, { type: "error", message: String(obj.message ?? "engine error") })
      return
    }
    if (name === "chat.event") {
      const ev = obj.event as OrchestratorEvent | undefined
      if (!ev) return
      if (ev.type === "user_input.request") {
        this.markRunState(taskId, tabId, "awaiting_input")
        this.pendingInputBroker.record(taskId, `${taskId}:${tabId}`, ev.requestId, ev.payload)
      }
      if (ev.type === "user_input.resolved") {
        this.clearRunState(taskId, tabId)
        this.pendingInputBroker.resolve(taskId, ev.requestId)
      }
      this.dispatch(taskId, tabId, ev)
    }
  }

  private upsertTask(task: Task): void {
    const tasks = this.tasksAcc()
    const idx = tasks.findIndex((t) => t.id === task.id)
    if (idx < 0) this.setTasks([...tasks, task])
    else this.setTasks(tasks.map((t) => (t.id === task.id ? task : t)))
  }

  private dispatch(taskId: string, tabId: string, ev: OrchestratorEvent): void {
    const set = this.subscribers.get(`${taskId}:${tabId}`)
    if (!set) return
    for (const cb of set) cb(ev)
  }

  private markRunState(taskId: string, tabId: string | undefined, state: ChatRunState): void {
    if (!tabId) return
    const next = new Map(this.runStateAcc())
    next.set(chatRunStateKey(taskId, tabId), state)
    this.setRunState(next)
  }

  private clearRunState(taskId: string, tabId: string): void {
    const next = new Map(this.runStateAcc())
    next.delete(chatRunStateKey(taskId, tabId))
    this.setRunState(next)
  }
}
