/**
 * RemoteOrchestrator (v0.6).
 *
 * Mirror of the slim {@link Orchestrator} that runs in the daemon, with
 * the same read surface (tasks signal + subscribe) and a write surface
 * that forwards each method as a daemon RPC. v0.5's chat-stream paths
 * (subscribeEvents, pending-input broker, plan-usage signal,
 * rcBridgeSignal) are gone — claude lives in tmux, the daemon no
 * longer brokers any of that.
 */

import { type Accessor, createEffect, createRoot, createSignal } from "solid-js"
import {
  DAEMON_PROTOCOL_VERSION,
  MIN_COMPATIBLE_PROTOCOL_VERSION,
  type SerializedTask,
  isProtocolCompatible,
} from "../daemon/protocol.ts"
import type { Orchestrator, Unsubscribe } from "../orchestrator/core.ts"
import type { Task, TaskId, TaskStatus, VendorId } from "../types/task.ts"
import { toTaskId } from "../types/task.ts"
import type { AdoptableWorktree } from "../types/worktree.ts"
import type { UpdateInfo } from "../version.ts"
import { ensureDaemonReachable } from "./daemon-process.ts"
import type { KobeDaemonClient } from "./index.ts"

export type KobeOrchestrator = Orchestrator | RemoteOrchestrator

/**
 * Daemon connection lifecycle as observed by the TUI. Two states
 * because reconnect is user-driven (the host shows a "Restart daemon
 * or Quit?" prompt when we go `disconnected`).
 */
export type DaemonConnectionState = "online" | "disconnected"

export interface RemoteOrchestratorOptions {
  /**
   * Bring the daemon back on the socket this client already points
   * at. Shared mode uses the stable production socket; single/owned
   * mode injects a restart function for its per-TUI socket.
   */
  readonly ensureReachable?: () => Promise<unknown>
}

export class RemoteOrchestrator {
  private readonly tasksAcc: Accessor<Task[]>
  private readonly setTasks: (next: Task[]) => void
  private readonly activeTaskAcc: Accessor<string | null>
  private readonly setActiveTaskSig: (next: string | null) => void
  private readonly updateAcc: Accessor<UpdateInfo | null>
  private readonly setUpdateSig: (next: UpdateInfo | null) => void
  private readonly connectionStateAcc: Accessor<DaemonConnectionState>
  private readonly setConnectionState: (next: DaemonConnectionState) => void
  private readonly ensureReachable: () => Promise<unknown>

  constructor(
    private readonly client: KobeDaemonClient,
    options: RemoteOrchestratorOptions = {},
  ) {
    const [tasks, setTasks] = createSignal<Task[]>([])
    const [activeTask, setActiveTask] = createSignal<string | null>(null)
    const [update, setUpdate] = createSignal<UpdateInfo | null>(null)
    const [connectionState, setConnectionState] = createSignal<DaemonConnectionState>("online")
    this.tasksAcc = tasks
    this.setTasks = (next) => setTasks(() => next)
    this.activeTaskAcc = activeTask
    this.setActiveTaskSig = (next) => setActiveTask(() => next)
    this.updateAcc = update
    this.setUpdateSig = (next) => setUpdate(() => next)
    this.connectionStateAcc = connectionState
    this.setConnectionState = (next) => setConnectionState(() => next)
    this.ensureReachable = options.ensureReachable ?? ensureDaemonReachable
    this.client.on("*", (frame) => this.handleEvent(frame.name, frame.payload))
    // KOB-38: socket drop flips us to `disconnected` and stops there.
    // The host TUI watches this signal, shows a modal, and the user
    // picks Restart (→ `manualReconnect`) or Quit.
    this.client.onLifecycle("close", () => this.setConnectionState("disconnected"))
  }

  /** Open the daemon socket, hello, subscribe to the task snapshot stream. */
  async init(): Promise<void> {
    // Send our protocol version so the daemon can reject a mismatch, and
    // verify the daemon's version so an OLD daemon (which predates the
    // server-side check) is caught client-side too — both surface the
    // documented "upgrade your kobe" error instead of cryptic failures.
    const hello = await this.client.request<{
      tasks?: SerializedTask[]
      protocolVersion?: number
      minProtocolVersion?: number
    }>("hello", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      minProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
    })
    const daemonVersion = typeof hello.protocolVersion === "number" ? hello.protocolVersion : DAEMON_PROTOCOL_VERSION
    const daemonMin = typeof hello.minProtocolVersion === "number" ? hello.minProtocolVersion : daemonVersion
    if (
      !isProtocolCompatible({
        localVersion: DAEMON_PROTOCOL_VERSION,
        localMin: MIN_COMPATIBLE_PROTOCOL_VERSION,
        remoteVersion: daemonVersion,
        remoteMin: daemonMin,
      })
    ) {
      throw new Error(
        `kobe daemon is protocol v${daemonVersion} (min v${daemonMin}); this client is v${DAEMON_PROTOCOL_VERSION} (min v${MIN_COMPATIBLE_PROTOCOL_VERSION}). Restart the daemon (\`kobe daemon restart\`) or upgrade kobe.`,
      )
    }
    if (hello.tasks) this.setTasks(hello.tasks.map(deserializeTask))
    // Subscribe to all channels (the daemon replays each channel's current
    // value on connect). We only consume `task.snapshot` here; future
    // channels get their own `client.onChannel(...)` consumers elsewhere.
    await this.client.subscribe()
    this.setConnectionState("online")
  }

  connectionStateSignal(): Accessor<DaemonConnectionState> {
    return this.connectionStateAcc
  }

  /**
   * User-driven reconnect after a `disconnected` event. The host TUI
   * calls this from the "Restart daemon or Quit?" modal.
   */
  async manualReconnect(): Promise<void> {
    this.client.forceDisconnect()
    await this.ensureReachable()
    await this.init()
  }

  dispose(): void {
    this.client.close()
  }

  // --- read ---

  tasksSignal(): Accessor<Task[]> {
    return this.tasksAcc
  }

  /**
   * The shared active task id (the session last switched/entered into),
   * pushed live on the `active-task` channel. Every surface reads this so
   * they all highlight the SAME focus (KOB-247). `null` until first set.
   */
  activeTaskSignal(): Accessor<string | null> {
    return this.activeTaskAcc
  }

  /**
   * Latest published-version info, pushed live on the daemon-owned `update`
   * channel (the daemon polls npm once and fans it out — panes don't poll
   * the registry themselves). `null` until the first check resolves, or when
   * the check is suppressed (dev) / unavailable (offline).
   */
  updateSignal(): Accessor<UpdateInfo | null> {
    return this.updateAcc
  }

  listTasks(): Task[] {
    return this.tasksAcc()
  }

  getTask(id: TaskId | string): Task | undefined {
    return this.tasksAcc().find((t) => t.id === id)
  }

  subscribeTasks(listener: (snapshot: readonly Task[]) => void): Unsubscribe {
    try {
      listener(this.listTasks())
    } catch (err) {
      console.error("[kobe RemoteOrchestrator] task listener threw on subscribe:", err)
    }
    // Forward subsequent snapshots reactively off the Solid signal instead
    // of polling it on a timer. createEffect re-runs whenever tasksAcc()
    // changes; createRoot gives it an owner so the returned disposer tears
    // it down. The effect fires once synchronously on creation — skip that
    // run since we already delivered the current snapshot eagerly above.
    let first = true
    return createRoot((dispose) => {
      createEffect(() => {
        const current = this.tasksAcc()
        if (first) {
          first = false
          return
        }
        try {
          listener(current)
        } catch (err) {
          console.error("[kobe RemoteOrchestrator] task listener threw:", err)
        }
      })
      return dispose
    })
  }

  // --- write ---

  async createTask(input: {
    repo: string
    title?: string
    branch?: string
    baseRef?: string
    vendor?: VendorId
  }): Promise<Task> {
    const res = await this.client.request<{ task: SerializedTask }>("task.create", input)
    return deserializeTask(res.task)
  }

  async ensureMainTask(repo: string): Promise<Task> {
    const res = await this.client.request<{ task: SerializedTask }>("task.ensureMain", { repo })
    return deserializeTask(res.task)
  }

  async ensureWorktree(id: TaskId | string): Promise<string> {
    const res = await this.client.request<{ worktreePath: string }>("task.ensureWorktree", { taskId: String(id) })
    return res.worktreePath
  }

  async setTitle(id: TaskId | string, title: string): Promise<void> {
    await this.client.request("task.rename", { taskId: String(id), title })
  }

  async setBranch(id: TaskId | string, branch: string): Promise<void> {
    await this.client.request("task.setBranch", { taskId: String(id), branch })
  }

  async setVendor(id: TaskId | string, vendor: VendorId): Promise<void> {
    await this.client.request("task.setVendor", { taskId: String(id), vendor })
  }

  async setPinned(id: TaskId | string, pinned?: boolean): Promise<void> {
    await this.client.request("task.pin", { taskId: String(id), pinned })
  }

  async setArchived(id: TaskId | string, archived?: boolean): Promise<void> {
    await this.client.request("task.archive", { taskId: String(id), archived })
  }

  async setStatus(id: TaskId | string, status: TaskStatus): Promise<void> {
    await this.client.request("task.status", { taskId: String(id), status })
  }

  async deleteTask(id: TaskId | string, opts?: { force?: boolean }): Promise<void> {
    await this.client.request("task.delete", { taskId: String(id), force: opts?.force })
  }

  async discoverAdoptableWorktrees(repo: string): Promise<readonly AdoptableWorktree[]> {
    const res = await this.client.request<{ worktrees: AdoptableWorktree[] }>("worktree.discoverAdoptable", { repo })
    return res.worktrees
  }

  async adoptWorktree(input: {
    repo: string
    worktreePath: string
    branch?: string
    vendor?: VendorId
    title?: string
  }): Promise<Task> {
    const res = await this.client.request<{ task: SerializedTask }>("worktree.adopt", input)
    return deserializeTask(res.task)
  }

  /**
   * Mark a task as the active focus (the session just switched/entered).
   * The daemon publishes it on the `active-task` channel so every Tasks
   * pane + the outer monitor highlight the same task (KOB-247).
   */
  async setActiveTask(id: TaskId | string | null): Promise<void> {
    await this.client.request("task.setActive", { taskId: id === null ? null : String(id) })
  }

  // --- internals ---

  private handleEvent(name: string, payload: unknown): void {
    if (name === "task.snapshot") {
      const value = (payload as { tasks?: SerializedTask[] } | undefined)?.tasks
      if (Array.isArray(value)) this.setTasks(value.map(deserializeTask))
      return
    }
    if (name === "active-task") {
      const id = (payload as { taskId?: string | null } | undefined)?.taskId
      this.setActiveTaskSig(typeof id === "string" ? id : null)
      return
    }
    if (name === "update") {
      const info = (payload as { info?: UpdateInfo | null } | undefined)?.info
      this.setUpdateSig(info ?? null)
    }
  }
}

function deserializeTask(s: SerializedTask): Task {
  return {
    id: toTaskId(s.id),
    title: s.title,
    repo: s.repo,
    branch: s.branch,
    worktreePath: s.worktreePath,
    kind: s.kind,
    status: s.status,
    archived: s.archived,
    pinned: s.pinned,
    vendor: s.vendor,
    prStatus: s.prStatus,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}
