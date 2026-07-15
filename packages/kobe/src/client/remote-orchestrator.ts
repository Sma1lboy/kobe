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
import type { RepoIssues } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import {
  type ChannelName,
  type NoticeEventPayload,
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
  type EngineTabStateMap,
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
  engineTabStatesSignalOp,
  getTaskOp,
  keybindingsRevSignalOp,
  keybindingsRevStoreOp,
  listTasksOp,
  noticeStoreOp,
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
  landTaskOp,
  listIssuesOp,
  listWorktreesOp,
  moveTaskOp,
  mutateIssueOp,
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
  EngineTabStateMap,
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
  private readonly engineTabStateAcc = createStateCell<EngineTabStateMap>(new Map())
  private readonly setEngineTabStateSig = (next: EngineTabStateMap) => this.engineTabStateAcc.set(next)
  private readonly taskJobsAcc = createStateCell<ReadonlyMap<string, TaskJobState>>(new Map())
  private readonly setTaskJobsSig = (next: ReadonlyMap<string, TaskJobState>) => this.taskJobsAcc.set(next)
  private readonly worktreeChangesAcc = createStateCell<WorktreeChangesMap | null>(null)
  private readonly setWorktreeChangesSig = (next: WorktreeChangesMap | null) => this.worktreeChangesAcc.set(next)
  private readonly transcriptActivityAcc = createStateCell<TranscriptActivityMap | null>(null)
  private readonly setTranscriptActivitySig = (next: TranscriptActivityMap | null) =>
    this.transcriptActivityAcc.set(next)
  private readonly noticeAcc = createStateCell<NoticeEventPayload | null>(null)
  private readonly setNoticeSig = (next: NoticeEventPayload | null) => this.noticeAcc.set(next)
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
  /** One shared retry task: repeated close events and an explicit reconnect
   *  join the same loop instead of racing two hello/subscribe handshakes. */
  private reconnectTask: Promise<void> | null = null
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
      engineTabStateAcc: this.engineTabStateAcc,
      setEngineTabStateSig: this.setEngineTabStateSig,
      taskJobsAcc: this.taskJobsAcc,
      setTaskJobsSig: this.setTaskJobsSig,
      worktreeChangesAcc: this.worktreeChangesAcc,
      setWorktreeChangesSig: this.setWorktreeChangesSig,
      transcriptActivityAcc: this.transcriptActivityAcc,
      setTranscriptActivitySig: this.setTranscriptActivitySig,
      setNoticeSig: this.setNoticeSig,
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
      engineTabStateAcc: this.engineTabStateAcc,
      taskJobsAcc: this.taskJobsAcc,
      worktreeChangesAcc: this.worktreeChangesAcc,
      transcriptActivityAcc: this.transcriptActivityAcc,
      transcriptActivityStoreInner: this.transcriptActivityAcc,
      noticeAcc: this.noticeAcc,
      noticeStoreInner: this.noticeAcc,
      uiPrefsAcc: this.uiPrefsAcc,
      uiPrefsStoreInner: this.uiPrefsAcc,
      keybindingsRevAcc: this.keybindingsRevAcc,
      keybindingsRevStoreInner: this.keybindingsRevAcc,
      connectionStateAcc: this.connectionStateAcc,
    }
    this.client.on("*", (frame) => this.handleEvent(frame.name, frame.payload))
    // Socket drop flips us to `disconnected`. What happens next depends on
    // the role:
    //   - gui:  AUTO-RECOVER (spawning). This is the front-end that owns daemon
    //     availability, so it silently ensures a daemon is running, reconnects,
    //     and re-subscribes until the current snapshot has been replayed.
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
      const spawnDaemon = this.role === "gui"
      logClient(
        "orch",
        spawnDaemon
          ? "daemon socket closed — starting silent spawning reconnect loop"
          : "daemon socket closed — starting non-spawning reconnect loop",
      )
      void this.reconnectLoop(spawnDaemon)
    })
  }

  /**
   * Start or join the role-appropriate reconnect loop. A GUI may spawn the
   * daemon; a pane only retries the existing socket so helper panes never
   * defeat daemon lazy-shutdown. On success subscribe replay rehydrates every
   * signal, including the current task snapshot.
   */
  private reconnectLoop(spawnDaemon: boolean): Promise<void> {
    if (this.reconnectTask) return this.reconnectTask
    const task = this.runReconnectLoop(spawnDaemon)
    this.reconnectTask = task
    const clear = (): void => {
      if (this.reconnectTask === task) this.reconnectTask = null
    }
    task.then(clear, clear)
    return task
  }

  private async runReconnectLoop(spawnDaemon: boolean): Promise<void> {
    let delayMs = spawnDaemon ? 0 : 500
    let attempt = 0
    while (!this.client.isDisposed) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      if (this.client.isDisposed) break
      attempt++
      try {
        if (spawnDaemon) await this.ensureReachable()
        await this.init()
        logClient("orch", `reconnected and re-subscribed after ${attempt} attempt(s) — task list re-synced`)
        return
      } catch (err) {
        // Pane failures are expected while no GUI owns a daemon; GUI failures
        // mean ensure/start itself is temporarily failing. Both stay silent in
        // the UI and use the same bounded forensic logging policy.
        if (shouldLogReconnectAttempt(attempt)) logClientError("orch-reconnect", err)
        delayMs = delayMs === 0 ? 500 : Math.min(delayMs * 2, 3000)
      }
    }
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

  /** Explicitly force the same spawning recovery used by a GUI socket drop. */
  async manualReconnect(): Promise<void> {
    this.client.forceDisconnect()
    await this.reconnectLoop(true)
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

  /** Per-TAB engine activity (taskId → tabId → state) — the F7 attention
   *  jump's tab-precise read. Sparse; see {@link EngineTabStateMap}. */
  engineTabStatesSignal(): ReadableState<EngineTabStateMap> {
    return engineTabStatesSignalOp(this.reads)
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

  /** Latest daemon-broadcast notice (`notice.event`) — consumers dedupe on `at`. */
  noticeStore(): ExternalStore<NoticeEventPayload | null> {
    return noticeStoreOp(this.reads)
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

  /** Land a task's branch back into its base repo (`task.land`). Throws with a
   *  `LAND_CONFLICT` / `MAIN_CHECKOUT_DIRTY` sentinel in the message on the
   *  guarded failures so callers can print the conflicted files / re-prompt. */
  landTask(id: TaskId | string, opts?: Parameters<typeof landTaskOp>[2]): ReturnType<typeof landTaskOp> {
    return landTaskOp(this.client, id, opts)
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

  /** A repo's daemon-owned issues (`issue.list`) — the kanban page's read. */
  listIssues(repoRoot: string): Promise<RepoIssues> {
    return listIssuesOp(this.client, repoRoot)
  }

  /** One issue-store mutation (`issue.mutate`) — the kanban detail drawer's
   *  write path (link on start, setStatus for the project placement). */
  mutateIssue(repoRoot: string, op: unknown): Promise<RepoIssues> {
    return mutateIssueOp(this.client, repoRoot, op)
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
