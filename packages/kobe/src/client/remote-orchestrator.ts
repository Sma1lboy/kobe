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
import { ensureDaemonReachable } from "@sma1lboy/kobe-daemon/client/daemon-process"
import type { RepoIssues } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import {
  type ChannelName,
  type NoticeEventPayload,
  type SubscribeRole,
  type TabOpenPayload,
  type UiPrefsPayload,
  type UiPromptPayload,
  isDaemonVersionStale,
} from "@sma1lboy/kobe-daemon/daemon/protocol"
import { type ExternalStore, type ReadableState, createStateCell, mapReadableState } from "../lib/external-store.ts"
import type { Orchestrator, Unsubscribe } from "../orchestrator/core.ts"
import type { Task, TaskId, TaskStatus, VendorId } from "../types/task.ts"
import type { AdoptableWorktree, WorktreeProject } from "../types/worktree.ts"
import { CURRENT_VERSION, type UpdateInfo } from "../version.ts"
import { performInit } from "./remote-orchestrator-connect.ts"
import { handleOrchestratorEvent } from "./remote-orchestrator-events.ts"
import type {
  AttentionInboxItem,
  DaemonConnectionState,
  EngineLifecycleMap,
  EngineTabStateMap,
  OrchestratorSignals,
  RecentTaskEvent,
  RemoteOrchestratorOptions,
  TaskEngineState,
  TaskJobState,
  TranscriptActivityMap,
  UsageSnapshotMap,
  WorktreeChangesMap,
} from "./remote-orchestrator-payloads.ts"
import {
  type ReadSignals,
  activeTaskSignalOp,
  attentionInboxSignalOp,
  daemonStaleSignalOp,
  daemonVersionSignalOp,
  engineStateSignalOp,
  engineTabStatesSignalOp,
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
  usageSnapshotSignalOp,
  worktreeChangesSignalOp,
} from "./remote-orchestrator-reads.ts"
import { RemoteReconnectController } from "./remote-orchestrator-reconnect.ts"
import {
  adoptWorktreeOp,
  automationRunsOp,
  createAutomationOp,
  createTaskOp,
  deleteAutomationOp,
  deleteTaskOp,
  discoverAdoptableWorktreesOp,
  dismissAttentionOp,
  ensureMainTaskOp,
  ensureWorktreeOp,
  forgetProjectOp,
  landTaskOp,
  listAutomationsOp,
  listIssuesOp,
  listWorkItemsOp,
  listWorktreesOp,
  markAttentionReadOp,
  moveTaskOp,
  mutateIssueOp,
  removeWorktreeOp,
  runAutomationNowOp,
  setActiveTaskOp,
  setArchivedOp,
  setAutomationEnabledOp,
  setBranchOp,
  setDelegationOp,
  setPinnedOp,
  setStatusOp,
  setTitleOp,
  setVendorOp,
  startWorkItemOp,
} from "./remote-orchestrator-writes.ts"

export type {
  AttentionInboxItem,
  DaemonConnectionState,
  EngineLifecycleMap,
  EngineLifecycleState,
  EngineTabStateMap,
  RecentTaskEvent,
  RemoteOrchestratorOptions,
  TaskEngineState,
  TaskJobState,
  TranscriptActivity,
  TranscriptActivityMap,
  UsageSnapshotMap,
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
  private readonly activeTaskAcc = createStateCell<string | null>(null)
  private readonly updateAcc = createStateCell<UpdateInfo | null>(null)
  private readonly daemonVersionAcc = createStateCell<string | null>(null)
  private readonly daemonStaleAcc = mapReadableState(this.daemonVersionAcc, (version) =>
    isDaemonVersionStale(version ?? undefined, CURRENT_VERSION),
  )
  private readonly engineStateAcc = createStateCell<ReadonlyMap<string, TaskEngineState>>(new Map())
  private readonly engineTabStateAcc = createStateCell<EngineTabStateMap>(new Map())
  private readonly attentionInboxAcc = createStateCell<readonly AttentionInboxItem[]>([])
  private readonly taskJobsAcc = createStateCell<ReadonlyMap<string, TaskJobState>>(new Map())
  private readonly worktreeChangesAcc = createStateCell<WorktreeChangesMap | null>(null)
  private readonly usageSnapshotAcc = createStateCell<UsageSnapshotMap | null>(null)
  private readonly transcriptActivityAcc = createStateCell<TranscriptActivityMap | null>(null)
  private readonly noticeAcc = createStateCell<NoticeEventPayload | null>(null)
  private readonly tabOpenAcc = createStateCell<TabOpenPayload | null>(null)
  private readonly uiPromptAcc = createStateCell<UiPromptPayload | null>(null)
  private readonly engineLifecycleAcc = createStateCell<EngineLifecycleMap>(new Map())
  private readonly uiPrefsAcc = createStateCell<UiPrefsPayload | null>(null)
  private readonly keybindingsRevAcc = createStateCell<number | null>(null)
  private readonly connectionStateAcc = createStateCell<DaemonConnectionState>("online")
  private readonly role: SubscribeRole
  /** Per-channel subscribe filter; `undefined` = subscribe to all channels. */
  private readonly channels?: readonly ChannelName[]
  /** True when the filter excludes `task.snapshot` — skip hello task hydration. */
  private readonly subscribesTasks: boolean
  private readonly reconnect: RemoteReconnectController
  /** Deps bag for `performInit`/`handleOrchestratorEvent` — see file header. */
  private readonly signals: OrchestratorSignals
  /** Deps bag for the read-accessor delegates — see remote-orchestrator-reads.ts. */
  private readonly reads: ReadSignals

  constructor(
    private readonly client: KobeDaemonClient,
    options: RemoteOrchestratorOptions = {},
  ) {
    this.role = options.role ?? "pane"
    this.channels = options.channels
    this.subscribesTasks = !options.channels || options.channels.includes("task.snapshot")
    this.signals = {
      tasksAcc: this.tasksAcc,
      setTasks: this.tasksAcc.set,
      setActiveTaskSig: this.activeTaskAcc.set,
      setUpdateSig: this.updateAcc.set,
      setDaemonVersionSig: this.daemonVersionAcc.set,
      engineStateAcc: this.engineStateAcc,
      setEngineStateSig: this.engineStateAcc.set,
      engineTabStateAcc: this.engineTabStateAcc,
      setEngineTabStateSig: this.engineTabStateAcc.set,
      setAttentionInboxSig: this.attentionInboxAcc.set,
      taskJobsAcc: this.taskJobsAcc,
      setTaskJobsSig: this.taskJobsAcc.set,
      worktreeChangesAcc: this.worktreeChangesAcc,
      setWorktreeChangesSig: this.worktreeChangesAcc.set,
      usageSnapshotAcc: this.usageSnapshotAcc,
      setUsageSnapshotSig: this.usageSnapshotAcc.set,
      transcriptActivityAcc: this.transcriptActivityAcc,
      setTranscriptActivitySig: this.transcriptActivityAcc.set,
      setNoticeSig: this.noticeAcc.set,
      setTabOpenSig: this.tabOpenAcc.set,
      setUiPromptSig: this.uiPromptAcc.set,
      engineLifecycleAcc: this.engineLifecycleAcc,
      setEngineLifecycleSig: this.engineLifecycleAcc.set,
      setUiPrefsSig: this.uiPrefsAcc.set,
      setKeybindingsRevSig: this.keybindingsRevAcc.set,
      setConnectionState: this.connectionStateAcc.set,
    }
    this.reads = {
      tasksAcc: this.tasksAcc,
      activeTaskAcc: this.activeTaskAcc,
      updateAcc: this.updateAcc,
      daemonVersionAcc: this.daemonVersionAcc,
      daemonStaleAcc: this.daemonStaleAcc,
      engineStateAcc: this.engineStateAcc,
      engineTabStateAcc: this.engineTabStateAcc,
      attentionInboxAcc: this.attentionInboxAcc,
      taskJobsAcc: this.taskJobsAcc,
      worktreeChangesAcc: this.worktreeChangesAcc,
      usageSnapshotAcc: this.usageSnapshotAcc,
      transcriptActivityAcc: this.transcriptActivityAcc,
      transcriptActivityStoreInner: this.transcriptActivityAcc,
      noticeAcc: this.noticeAcc,
      uiPrefsAcc: this.uiPrefsAcc,
      uiPrefsStoreInner: this.uiPrefsAcc,
      keybindingsRevAcc: this.keybindingsRevAcc,
      keybindingsRevStoreInner: this.keybindingsRevAcc,
      connectionStateAcc: this.connectionStateAcc,
    }
    this.client.on("*", (frame) => this.handleEvent(frame.name, frame.payload))
    this.reconnect = new RemoteReconnectController({
      client: this.client,
      role: this.role,
      ensureReachable: options.ensureReachable ?? ensureDaemonReachable,
      init: () => this.init(),
      setDisconnected: () => this.connectionStateAcc.set("disconnected"),
    })
    this.client.onLifecycle("close", () => this.reconnect.onClose())
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
    await this.reconnect.manualReconnect()
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

  readonly attentionInboxSignal = (): ReadableState<readonly AttentionInboxItem[]> => attentionInboxSignalOp(this.reads)

  readonly taskJobsSignal = (): ReadableState<ReadonlyMap<string, TaskJobState>> => taskJobsSignalOp(this.reads)

  readonly worktreeChangesSignal = (): ReadableState<WorktreeChangesMap | null> => worktreeChangesSignalOp(this.reads)

  readonly usageSnapshotSignal = (): ReadableState<UsageSnapshotMap | null> => usageSnapshotSignalOp(this.reads)

  readonly transcriptActivitySignal = (): ReadableState<TranscriptActivityMap | null> =>
    transcriptActivitySignalOp(this.reads)

  readonly transcriptActivityStore = (): ExternalStore<TranscriptActivityMap | null> =>
    transcriptActivityStoreOp(this.reads)

  /** Latest daemon-broadcast notice (`notice.event`) — consumers dedupe on `at`. */
  readonly noticeStore = (): ExternalStore<NoticeEventPayload | null> => this.noticeAcc

  /** Latest `tab.open` request (plugin panes) — consumers dedupe on `at`. */
  readonly tabOpenStore = (): ExternalStore<TabOpenPayload | null> => this.tabOpenAcc

  /** Latest `ui.prompt` request (host input dialog) — consumers dedupe on `at`. */
  readonly uiPromptStore = (): ExternalStore<UiPromptPayload | null> => this.uiPromptAcc

  /** Answer a `ui.prompt` request; omit `value` to report a cancel. */
  readonly replyPrompt = (promptId: string, value?: string): void =>
    void this.client.request("ui.promptReply", { promptId, ...(value !== undefined ? { value } : {}) }).catch(() => {})

  /** Transient per-task lifecycle marks (subagent activity). */
  readonly engineLifecycleSignal = (): ReadableState<EngineLifecycleMap> => this.engineLifecycleAcc

  /** One task's recent engine events (the event feed; newest last). */
  recentTaskEvents(id: TaskId | string): Promise<{ events: readonly RecentTaskEvent[] }> {
    return this.client.request("task.recentEvents", { taskId: String(id) })
  }

  /** Fire-and-forget UI moment → plugin event hooks (`ui.reportEvent`). */
  readonly reportUiEvent = (kind: string, taskId?: string, detail?: Record<string, unknown>): void =>
    void this.client
      .request("ui.reportEvent", { kind, ...(taskId ? { taskId } : {}), ...(detail ? { detail } : {}) })
      .catch(() => {})

  readonly uiPrefsSignal = (): ReadableState<UiPrefsPayload | null> => uiPrefsSignalOp(this.reads)

  readonly uiPrefsStore = (): ExternalStore<UiPrefsPayload | null> => uiPrefsStoreOp(this.reads)

  readonly keybindingsRevSignal = (): ReadableState<number | null> => keybindingsRevSignalOp(this.reads)

  readonly keybindingsRevStore = (): ExternalStore<number | null> => keybindingsRevStoreOp(this.reads)

  readonly listTasks = (): Task[] => listTasksOp(this.reads)

  readonly getTask = (id: TaskId | string): Task | undefined => getTaskOp(this.reads, id)

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

  setDelegation(subagentId: TaskId | string, primaryId: TaskId | string): Promise<void> {
    return setDelegationOp(this.client, subagentId, primaryId)
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

  dismissAttention(taskId: TaskId | string, tabId: string | null, at: number): Promise<boolean> {
    return dismissAttentionOp(this.client, taskId, tabId, at)
  }

  markAttentionRead(taskId: TaskId | string, tabId: string | null, at: number): Promise<boolean> {
    return markAttentionReadOp(this.client, taskId, tabId, at)
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

  // Automations + external work items (docs/design/{automations,work-items}.md).
  // Terse one-liners on purpose: pure forwarding, and this file is at the cap.
  listAutomations = () => listAutomationsOp(this.client)
  createAutomation = (i: Parameters<typeof createAutomationOp>[1]) => createAutomationOp(this.client, i)
  automationRuns = (id: string) => automationRunsOp(this.client, id)
  setAutomationEnabled = (id: string, on: boolean) => setAutomationEnabledOp(this.client, id, on)
  runAutomationNow = (id: string) => runAutomationNowOp(this.client, id)
  deleteAutomation = (id: string) => deleteAutomationOp(this.client, id)
  listWorkItems = (a: Parameters<typeof listWorkItemsOp>[1]) => listWorkItemsOp(this.client, a)
  startWorkItem = (a: Parameters<typeof startWorkItemOp>[1]) => startWorkItemOp(this.client, a)

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
