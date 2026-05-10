import { type Accessor, createSignal } from "solid-js"
import { type ChatRunState, type Orchestrator, type Unsubscribe, chatRunStateKey } from "../orchestrator/core.ts"
import type {
  Message,
  OrchestratorEvent,
  PermissionMode,
  SessionMeta,
  UserInputPayload,
  UserInputResponse,
} from "../types/engine.ts"
import type { ChatTab, Task } from "../types/task.ts"
import type { KobeDaemonClient } from "./index.ts"

type PendingInput = { requestId: string; payload: UserInputPayload }
export type KobeOrchestrator = Orchestrator | RemoteOrchestrator

export class RemoteOrchestrator {
  private readonly tasksAcc: Accessor<Task[]>
  private readonly setTasks: (next: Task[]) => void
  private readonly runStateAcc: Accessor<ReadonlyMap<string, ChatRunState>>
  private readonly setRunState: (next: ReadonlyMap<string, ChatRunState>) => void
  private readonly subscribers = new Map<string, Set<(ev: OrchestratorEvent) => void>>()
  /**
   * Mirror of the daemon's per-task pending-input bucket. Hydrated on
   * `init()` via `chat.input.pending` round-trips, then maintained
   * forward by listening to `user_input.request` / `user_input.resolved`
   * events on the wire. Keeps `peekPendingInput` honest for clients
   * that attach mid-session — a TUI joining while a task is
   * `awaiting_input` for an ExitPlanMode / AskUserQuestion needs to see
   * the pending request to lock the composer and render the picker.
   */
  private readonly pendingInputs = new Map<string, PendingInput[]>()

  constructor(private readonly client: KobeDaemonClient) {
    const [tasks, setTasks] = createSignal<Task[]>([])
    const [runState, setRunState] = createSignal<ReadonlyMap<string, ChatRunState>>(new Map())
    this.tasksAcc = tasks
    this.setTasks = (next) => setTasks(() => next)
    this.runStateAcc = runState
    this.setRunState = (next) => setRunState(() => next)
    this.client.on("*", (frame) => this.handleEvent(frame.name, frame.payload))
  }

  async init(): Promise<void> {
    await this.client.request("hello", { clientId: `tui-${process.pid}`, version: "1" })
    const res = await this.client.request<{ tasks: Task[] }>("task.list")
    this.setTasks(res.tasks)
    await this.client.request("subscribe", { taskIds: "all" })
    // Hydrate pending-input snapshots per task. Cheap (one round-trip
    // per task) and run in parallel; if a task has no pending requests
    // the daemon returns `pending: []` and we just leave the local
    // bucket empty. Failures per task are non-fatal — the worst case
    // is the composer doesn't lock until the next user_input.request
    // arrives over the wire, same as before this hydration existed.
    await Promise.all(
      res.tasks.map(async (task) => {
        try {
          const pending = await this.client.request<{ pending: PendingInput[] }>("chat.input.pending", {
            taskId: task.id,
          })
          if (pending.pending.length > 0) this.pendingInputs.set(task.id, [...pending.pending])
        } catch {
          /* per-task hydration is best-effort */
        }
      }),
    )
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

  async setModel(taskId: string, model: string | undefined): Promise<void> {
    await this.client.request("task.model", { taskId, model })
  }

  async createTab(taskId: string, opts: { title?: string } = {}): Promise<ChatTab> {
    const res = await this.client.request<{ tab: ChatTab }>("chat.tab.create", { taskId, title: opts.title })
    return res.tab
  }

  async closeTab(taskId: string, tabId: string): Promise<string> {
    const res = await this.client.request<{ nextActive: string }>("chat.tab.close", { taskId, tabId })
    return res.nextActive
  }

  async setActiveTab(taskId: string, tabId: string): Promise<void> {
    await this.client.request("chat.tab.activate", { taskId, tabId })
  }

  async readHistory(sessionId: string): Promise<Message[]> {
    const task = this.tasksAcc().find(
      (t) => t.sessionId === sessionId || t.tabs.some((tab) => tab.sessionId === sessionId),
    )
    if (!task) return []
    // Pass the requested sessionId through to the daemon so it returns
    // history for the specific tab the caller asked about, not the
    // task's currently-active tab. Without this, Chat's per-tab
    // hydration runs N times for the same active-tab transcript and
    // every tab ends up rendering identical content.
    const res = await this.client.request<{ messages: Message[] }>("chat.history", {
      taskId: task.id,
      sessionId,
      limit: 500,
    })
    return res.messages
  }

  async listSessions(taskId: string): Promise<SessionMeta[]> {
    const res = await this.client.request<{ sessions: SessionMeta[] }>("chat.sessions", { taskId })
    return res.sessions
  }

  async openSessionInTab(taskId: string, sessionId: string, opts: { title?: string } = {}): Promise<string> {
    const res = await this.client.request<{ tabId: string }>("chat.session.open", {
      taskId,
      sessionId,
      title: opts.title,
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
    const bucket = this.pendingInputs.get(taskId)
    return bucket ? bucket.slice() : []
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
        this.pendingInputs.delete(taskId)
      }
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
        this.recordPendingInput(taskId, ev.requestId, ev.payload)
      }
      if (ev.type === "user_input.resolved") {
        this.clearRunState(taskId, tabId)
        this.dropPendingInput(taskId, ev.requestId)
      }
      this.dispatch(taskId, tabId, ev)
    }
  }

  private recordPendingInput(taskId: string, requestId: string, payload: UserInputPayload): void {
    const existing = this.pendingInputs.get(taskId) ?? []
    if (existing.some((p) => p.requestId === requestId)) return
    this.pendingInputs.set(taskId, [...existing, { requestId, payload }])
  }

  private dropPendingInput(taskId: string, requestId: string): void {
    const existing = this.pendingInputs.get(taskId)
    if (!existing) return
    const next = existing.filter((p) => p.requestId !== requestId)
    if (next.length === 0) this.pendingInputs.delete(taskId)
    else this.pendingInputs.set(taskId, next)
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
