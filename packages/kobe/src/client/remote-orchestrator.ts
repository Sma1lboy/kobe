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
import { DAEMON_PROTOCOL_VERSION, type SerializedTask } from "../daemon/protocol.ts"
import type { Orchestrator, Unsubscribe } from "../orchestrator/core.ts"
import type { Task, TaskId, TaskStatus, VendorId } from "../types/task.ts"
import { toTaskId } from "../types/task.ts"
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
  private readonly connectionStateAcc: Accessor<DaemonConnectionState>
  private readonly setConnectionState: (next: DaemonConnectionState) => void
  private readonly ensureReachable: () => Promise<unknown>

  constructor(
    private readonly client: KobeDaemonClient,
    options: RemoteOrchestratorOptions = {},
  ) {
    const [tasks, setTasks] = createSignal<Task[]>([])
    const [connectionState, setConnectionState] = createSignal<DaemonConnectionState>("online")
    this.tasksAcc = tasks
    this.setTasks = (next) => setTasks(() => next)
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
    const hello = await this.client.request<{ tasks?: SerializedTask[]; protocolVersion?: number }>("hello", {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
    })
    if (typeof hello.protocolVersion === "number" && hello.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
      throw new Error(
        `kobe daemon is protocol v${hello.protocolVersion}; this client is v${DAEMON_PROTOCOL_VERSION}. Restart the daemon (\`kobe daemon restart\`) or upgrade kobe.`,
      )
    }
    if (hello.tasks) this.setTasks(hello.tasks.map(deserializeTask))
    await this.client.request("subscribe")
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

  // --- internals ---

  private handleEvent(name: string, payload: unknown): void {
    if (name !== "task.snapshot") return
    const value = (payload as { tasks?: SerializedTask[] } | undefined)?.tasks
    if (!Array.isArray(value)) return
    this.setTasks(value.map(deserializeTask))
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
