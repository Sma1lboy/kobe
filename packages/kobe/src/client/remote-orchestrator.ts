/**
 * RemoteOrchestrator (v0.6). Mirror of the slim {@link Orchestrator} that
 * runs in the daemon: same read surface (tasks signal + subscribe), and a
 * write surface forwarding each method as a daemon RPC.
 *
 * File-size-cap split: `performInit`/`handleOrchestratorEvent`
 * (`remote-orchestrator-connect.ts`/`-events.ts`) take an explicit
 * {@link OrchestratorSignals} deps bag — built once in the constructor from
 * the same framework-free state cells this class's read methods return — instead of
 * closing over `this`. Write methods below are 1-line delegates to
 * `remote-orchestrator-writes.ts`. Wire-payload types/helpers live in
 * `remote-orchestrator-payloads.ts`, re-exported below for existing importers.
 */

import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { logClient, logClientError } from "@sma1lboy/kobe-daemon/client/client-log"
import { ensureDaemonReachable } from "@sma1lboy/kobe-daemon/client/daemon-process"
import {
  type ChannelName,
  type SubscribeRole,
  type UiPrefsPayload,
  isDaemonVersionStale,
} from "@sma1lboy/kobe-daemon/daemon/protocol"
import { type ExternalStore, type ReadableState, createStateCell, mapReadableState } from "../lib/external-store.ts"
import type { Orchestrator, Unsubscribe } from "../orchestrator/core.ts"
import type { Task, TaskId, TaskStatus, VendorId } from "../types/task.ts"
import type { AdoptableWorktree, WorktreeProject } from "../types/worktree.ts"
import { CURRENT_VERSION, type UpdateInfo } from "../version.ts"
import { performInit } from "./remote-orchestrator-connect.ts"
import { handleOrchestratorEvent } from "./remote-orchestrator-events.ts"
import {
  type DaemonConnectionState,
  type OrchestratorSignals,
  type RemoteOrchestratorOptions,
  type TaskEngineState,
  type TaskJobState,
  type TranscriptActivityMap,
  type WorktreeChangesMap,
  shouldLogReconnectAttempt,
} from "./remote-orchestrator-payloads.ts"
import {
  type ReadSignals,
  activeTaskSignalOp,
  daemonStaleSignalOp,
  daemonVersionSignalOp,
  engineStateSignalOp,
  getTaskOp,
  keybindingsRevSignalOp,
  keybindingsRevStoreOp,
  listTasksOp,
  subscribeTasksOp,
  taskJobsSignalOp,
  tasksSignalOp,
  transcriptActivitySignalOp,
  transcriptActivityStoreOp,
  uiPrefsSignalOp,
  uiPrefsStoreOp,
  updateSignalOp,
  worktreeChangesSignalOp,
} from "./remote-orchestrator-reads.ts"
import {
  adoptWorktreeOp,
  createTaskOp,
  deleteTaskOp,
  discoverAdoptableWorktreesOp,
  ensureMainTaskOp,
  ensureWorktreeOp,
  forgetProjectOp,
  listWorktreesOp,
  moveTaskOp,
  removeWorktreeOp,
  setActiveTaskOp,
  setArchivedOp,
  setBranchOp,
  setPinnedOp,
  setStatusOp,
  setTitleOp,
  setVendorOp,
} from "./remote-orchestrator-writes.ts"

export type {
  DaemonConnectionState,
  RemoteOrchestratorOptions,
  TaskEngineState,
  TaskJobState,
  TranscriptActivity,
  TranscriptActivityMap,
  WorktreeChangesMap,
} from "./remote-orchestrator-payloads.ts"
export {
  decodeUiPrefsPayload,
  parseTranscriptActivityPayload,
  parseWorktreeChangesPayload,
  sameTranscriptActivityMap,
  sameWorktreeChangesMap,
} from "./remote-orchestrator-payloads.ts"

export type KobeOrchestrator = Orchestrator | RemoteOrchestrator

export class RemoteOrchestrator {
  private readonly tasksAcc = createStateCell<Task[]>([])
  private readonly setTasks = (next: Task[]) => this.tasksAcc.set(next)
  private readonly activeTaskAcc = createStateCell<string | null>(null)
  private readonly setActiveTaskSig = (next: string | null) => this.activeTaskAcc.set(next)
  private readonly updateAcc = createStateCell<UpdateInfo | null>(null)
  private readonly setUpdateSig = (next: UpdateInfo | null) => this.updateAcc.set(next)
  private readonly daemonVersionAcc = createStateCell<string | null>(null)
  private readonly setDaemonVersionSig = (next: string | null) => this.daemonVersionAcc.set(next)
  private readonly daemonStaleAcc = mapReadableState(this.daemonVersionAcc, (version) =>
    isDaemonVersionStale(version ?? undefined, CURRENT_VERSION),
  )
  private readonly engineStateAcc = createStateCell<ReadonlyMap<string, TaskEngineState>>(new Map())
  private readonly setEngineStateSig = (next: ReadonlyMap<string, TaskEngineState>) => this.engineStateAcc.set(next)
  private readonly taskJobsAcc = createStateCell<ReadonlyMap<string, TaskJobState>>(new Map())
  private readonly setTaskJobsSig = (next: ReadonlyMap<string, TaskJobState>) => this.taskJobsAcc.set(next)
  private readonly worktreeChangesAcc = createStateCell<WorktreeChangesMap | null>(null)
  private readonly setWorktreeChangesSig = (next: WorktreeChangesMap | null) => this.worktreeChangesAcc.set(next)
  private readonly transcriptActivityAcc = createStateCell<TranscriptActivityMap | null>(null)
  private readonly setTranscriptActivitySig = (next: TranscriptActivityMap | null) =>
    this.transcriptActivityAcc.set(next)
  private readonly uiPrefsAcc = createStateCell<UiPrefsPayload | null>(null)
  private readonly setUiPrefsSig = (next: UiPrefsPayload | null) => this.uiPrefsAcc.set(next)
  private readonly keybindingsRevAcc = createStateCell<number | null>(null)
  private readonly setKeybindingsRevSig = (next: number | null) => this.keybindingsRevAcc.set(next)
  private readonly connectionStateAcc = createStateCell<DaemonConnectionState>("online")
  private readonly setConnectionState = (next: DaemonConnectionState) => this.connectionStateAcc.set(next)
  private readonly ensureReachable: () => Promise<unknown>
  private readonly role: SubscribeRole
  /** Per-channel subscribe filter; `undefined` = subscribe to all channels. */
  private readonly channels?: readonly ChannelName[]
  /** True when the filter excludes `task.snapshot` — skip hello task hydration. */
  private readonly subscribesTasks: boolean
  /** Guards against stacking multiple reconnect loops (one `close` already
   *  running a retry loop must not spawn a second on the next `close`). */
  private reconnecting = false
  /** Deps bag for `performInit`/`handleOrchestratorEvent` — see file header. */
  private readonly signals: OrchestratorSignals
  /** Deps bag for the read-accessor delegates — see remote-orchestrator-reads.ts. */
  private readonly reads: ReadSignals

  constructor(
    private readonly client: KobeDaemonClient,
    options: RemoteOrchestratorOptions = {},
  ) {
    this.ensureReachable = options.ensureReachable ?? ensureDaemonReachable
    this.role = options.role ?? "pane"
    this.channels = options.channels
    this.subscribesTasks = !options.channels || options.channels.includes("task.snapshot")
    this.signals = {
      tasksAcc: this.tasksAcc,
      setTasks: this.setTasks,
      setActiveTaskSig: this.setActiveTaskSig,
      setUpdateSig: this.setUpdateSig,
      setDaemonVersionSig: this.setDaemonVersionSig,
      engineStateAcc: this.engineStateAcc,
      setEngineStateSig: this.setEngineStateSig,
      taskJobsAcc: this.taskJobsAcc,
      setTaskJobsSig: this.setTaskJobsSig,
      worktreeChangesAcc: this.worktreeChangesAcc,
      setWorktreeChangesSig: this.setWorktreeChangesSig,
      transcriptActivityAcc: this.transcriptActivityAcc,
      setTranscriptActivitySig: this.setTranscriptActivitySig,
      setUiPrefsSig: this.setUiPrefsSig,
      setKeybindingsRevSig: this.setKeybindingsRevSig,
      setConnectionState: this.setConnectionState,
    }
    this.reads = {
      tasksAcc: this.tasksAcc,
      activeTaskAcc: this.activeTaskAcc,
      updateAcc: this.updateAcc,
      daemonVersionAcc: this.daemonVersionAcc,
      daemonStaleAcc: this.daemonStaleAcc,
      engineStateAcc: this.engineStateAcc,
      taskJobsAcc: this.taskJobsAcc,
      worktreeChangesAcc: this.worktreeChangesAcc,
      transcriptActivityAcc: this.transcriptActivityAcc,
      transcriptActivityStoreInner: this.transcriptActivityAcc,
      uiPrefsAcc: this.uiPrefsAcc,
      uiPrefsStoreInner: this.uiPrefsAcc,
      keybindingsRevAcc: this.keybindingsRevAcc,
      keybindingsRevStoreInner: this.keybindingsRevAcc,
      connectionStateAcc: this.connectionStateAcc,
    }
    this.client.on("*", (frame) => this.handleEvent(frame.name, frame.payload))
    // Socket drop flips us to `disconnected`. What happens next depends on
    // the role:
    //   - gui:  STOP here. The host TUI watches this signal, shows
    //     a "Restart daemon or Quit?" modal, and the user decides — a gui
    //     losing its daemon is rare and never transient, so a human prompt
    //     beats a backoff loop.
    //   - pane: AUTO-RECONNECT (non-spawning). An in-tmux pane DOES routinely
    //     lose its daemon — the refcounted lazy-shutdown idle-stops the daemon
    //     3s after the last gui quits, while the pane persists with the tmux
    //     session. Without reconnect the pane's task list froze forever at the
    //     last snapshot (the create/delete sync drift). The loop reconnects to
    //     the SAME socket when a daemon returns and re-subscribes → the bus
    //     replays the current task.snapshot → the pane re-syncs. It must NOT
    //     spawn a daemon (that would resurrect an idle-stopped daemon and break
    //     lazy-shutdown — panes alone never hold it alive), so it only retries
    //     a plain connect, never `ensureReachable`.
    this.client.onLifecycle("close", () => {
      this.setConnectionState("disconnected")
      if (this.role === "pane") {
        logClient("orch", "daemon socket closed — starting non-spawning reconnect loop")
        void this.reconnectLoop()
      }
    })
  }

  /**
   * Reconnect a `role: "pane"` orchestrator to the daemon WITHOUT spawning
   * one. Retries {@link init} (a plain connect + hello + subscribe — never
   * `ensureReachable`) with capped backoff until it succeeds or the host
   * disposes the client. On success the daemon replays every channel's
   * last value, so `tasksSignal()` re-hydrates to the current list with no
   * extra round-trip. Idempotent: a second `close` while a loop is already
   * running is a no-op.
   */
  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true
    let delayMs = 500
    let attempt = 0
    while (!this.client.isDisposed) {
      await new Promise((r) => setTimeout(r, delayMs))
      if (this.client.isDisposed) break
      attempt++
      try {
        await this.init()
        logClient("orch", `reconnected and re-subscribed after ${attempt} attempt(s) — task list re-synced`)
        this.reconnecting = false
        return
      } catch (err) {
        // Expected while no daemon is listening yet (ECONNREFUSED): the user
        // hasn't re-attached, so no gui has spawned a daemon. Keep waiting
        // quietly — do NOT spawn one ourselves. Attempt 1 and every 10th up
        // to RECONNECT_LOG_ATTEMPT_CEILING, then silent: with many
        // long-lived orphan panes retrying for days, "every 10th" alone is
        // still unbounded spam (issue #26 — client.log hit 736MB). A
        // successful reconnect resets `attempt` back to 0 on the next close.
        if (shouldLogReconnectAttempt(attempt)) logClientError("orch-reconnect", err)
        delayMs = Math.min(delayMs * 2, 3000)
      }
    }
    this.reconnecting = false
  }

  /** Open the daemon socket, hello, subscribe to the task snapshot stream. */
  async init(): Promise<void> {
    await performInit(
      this.client,
      { role: this.role, channels: this.channels, subscribesTasks: this.subscribesTasks },
      this.signals,
    )
  }

  connectionStateSignal(): ReadableState<DaemonConnectionState> {
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

  // --- read --- (each a thin delegate; bodies + docs moved to remote-orchestrator-reads.ts)

  tasksSignal(): ReadableState<Task[]> {
    return tasksSignalOp(this.reads)
  }

  activeTaskSignal(): ReadableState<string | null> {
    return activeTaskSignalOp(this.reads)
  }

  updateSignal(): ReadableState<UpdateInfo | null> {
    return updateSignalOp(this.reads)
  }

  daemonVersionSignal(): ReadableState<string | null> {
    return daemonVersionSignalOp(this.reads)
  }

  daemonStaleSignal(): ReadableState<boolean> {
    return daemonStaleSignalOp(this.reads)
  }

  engineStateSignal(): ReadableState<ReadonlyMap<string, TaskEngineState>> {
    return engineStateSignalOp(this.reads)
  }

  taskJobsSignal(): ReadableState<ReadonlyMap<string, TaskJobState>> {
    return taskJobsSignalOp(this.reads)
  }

  worktreeChangesSignal(): ReadableState<WorktreeChangesMap | null> {
    return worktreeChangesSignalOp(this.reads)
  }

  transcriptActivitySignal(): ReadableState<TranscriptActivityMap | null> {
    return transcriptActivitySignalOp(this.reads)
  }

  transcriptActivityStore(): ExternalStore<TranscriptActivityMap | null> {
    return transcriptActivityStoreOp(this.reads)
  }

  uiPrefsSignal(): ReadableState<UiPrefsPayload | null> {
    return uiPrefsSignalOp(this.reads)
  }

  uiPrefsStore(): ExternalStore<UiPrefsPayload | null> {
    return uiPrefsStoreOp(this.reads)
  }

  keybindingsRevSignal(): ReadableState<number | null> {
    return keybindingsRevSignalOp(this.reads)
  }

  keybindingsRevStore(): ExternalStore<number | null> {
    return keybindingsRevStoreOp(this.reads)
  }

  listTasks(): Task[] {
    return listTasksOp(this.reads)
  }

  getTask(id: TaskId | string): Task | undefined {
    return getTaskOp(this.reads, id)
  }

  subscribeTasks(listener: (snapshot: readonly Task[]) => void): Unsubscribe {
    return subscribeTasksOp(this.reads, listener)
  }

  // --- write --- (each a thin delegate; bodies moved to remote-orchestrator-writes.ts)

  createTask(input: Parameters<typeof createTaskOp>[1]): Promise<Task> {
    return createTaskOp(this.client, input)
  }

  ensureMainTask(repo: string): Promise<Task> {
    return ensureMainTaskOp(this.client, repo)
  }

  ensureWorktree(id: TaskId | string): Promise<string> {
    return ensureWorktreeOp(this.client, id)
  }

  forgetProject(repo: string): Promise<void> {
    return forgetProjectOp(this.client, repo)
  }

  setTitle(id: TaskId | string, title: string): Promise<void> {
    return setTitleOp(this.client, id, title)
  }

  setBranch(id: TaskId | string, branch: string): Promise<void> {
    return setBranchOp(this.client, id, branch)
  }

  setVendor(id: TaskId | string, vendor: VendorId): Promise<void> {
    return setVendorOp(this.client, id, vendor)
  }

  setPinned(id: TaskId | string, pinned?: boolean): Promise<void> {
    return setPinnedOp(this.client, id, pinned)
  }

  moveTask(id: TaskId | string, delta: -1 | 1): Promise<void> {
    return moveTaskOp(this.client, id, delta)
  }

  setArchived(id: TaskId | string, archived?: boolean): Promise<void> {
    return setArchivedOp(this.client, id, archived)
  }

  setStatus(id: TaskId | string, status: TaskStatus): Promise<void> {
    return setStatusOp(this.client, id, status)
  }

  deleteTask(id: TaskId | string, opts?: { force?: boolean }): Promise<void> {
    return deleteTaskOp(this.client, id, opts)
  }

  discoverAdoptableWorktrees(repo: string): Promise<readonly AdoptableWorktree[]> {
    return discoverAdoptableWorktreesOp(this.client, repo)
  }

  adoptWorktree(input: Parameters<typeof adoptWorktreeOp>[1]): Promise<Task> {
    return adoptWorktreeOp(this.client, input)
  }

  /** Every worktree of every local saved project — the standalone
   *  worktree-management TUI page (`worktree.list`). `network: false` =
   *  local-signals-only fast pass. */
  listWorktrees(opts?: { network?: boolean }): Promise<readonly WorktreeProject[]> {
    return listWorktreesOp(this.client, opts)
  }

  /** Remove a worktree (`worktree.remove`); refuses a dirty one unless
   *  `force` is true — same safety property `GitWorktreeManager.remove`
   *  always had. */
  removeWorktree(path: string, force?: boolean): Promise<void> {
    return removeWorktreeOp(this.client, path, force)
  }

  /**
   * Mark a task as the active focus (the session just switched/entered).
   * The daemon publishes it on the `active-task` channel so every Tasks
   * pane + the outer monitor highlight the same task.
   */
  setActiveTask(id: TaskId | string | null): Promise<void> {
    return setActiveTaskOp(this.client, id)
  }

  // --- internals ---

  private handleEvent(name: string, payload: unknown): void {
    handleOrchestratorEvent(name, payload, this.signals)
  }
}
