import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { logClient, logClientError } from "@sma1lboy/kobe-daemon/client/client-log"
import { ensureDaemonReachable } from "@sma1lboy/kobe-daemon/client/daemon-process"
import type { ChannelName, SubscribeRole, UiPrefsPayload } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { isDaemonVersionStale } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { type Accessor, createEffect, createRoot, createSignal } from "solid-js"
import { type ExternalStore, createExternalStore } from "../lib/external-store.ts"
import type { Orchestrator, Unsubscribe } from "../orchestrator/core.ts"
import type { Task, TaskId, TaskStatus, VendorId } from "../types/task.ts"
import type { AdoptableWorktree, WorktreeProject } from "../types/worktree.ts"
import { CURRENT_VERSION, type UpdateInfo } from "../version.ts"
import { performInit } from "./remote-orchestrator-connect.ts"
import { handleOrchestratorEvent } from "./remote-orchestrator-events.ts"
import type {
  DaemonConnectionState,
  OrchestratorSignals,
  RemoteOrchestratorOptions,
  TaskEngineState,
  TaskJobState,
  TranscriptActivityMap,
  WorktreeChangesMap,
} from "./remote-orchestrator-payloads.ts"
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
  private readonly tasksAcc: Accessor<Task[]>
  private readonly setTasks: (next: Task[]) => void
  private readonly activeTaskAcc: Accessor<string | null>
  private readonly setActiveTaskSig: (next: string | null) => void
  private readonly updateAcc: Accessor<UpdateInfo | null>
  private readonly setUpdateSig: (next: UpdateInfo | null) => void
  private readonly daemonVersionAcc: Accessor<string | null>
  private readonly setDaemonVersionSig: (next: string | null) => void
  private readonly engineStateAcc: Accessor<ReadonlyMap<string, TaskEngineState>>
  private readonly setEngineStateSig: (next: ReadonlyMap<string, TaskEngineState>) => void
  private readonly taskJobsAcc: Accessor<ReadonlyMap<string, TaskJobState>>
  private readonly setTaskJobsSig: (next: ReadonlyMap<string, TaskJobState>) => void
  private readonly worktreeChangesAcc: Accessor<WorktreeChangesMap | null>
  private readonly setWorktreeChangesSig: (next: WorktreeChangesMap | null) => void
  private readonly transcriptActivityAcc: Accessor<TranscriptActivityMap | null>
  private readonly setTranscriptActivitySig: (next: TranscriptActivityMap | null) => void
  private readonly uiPrefsAcc: Accessor<UiPrefsPayload | null>
  private readonly setUiPrefsSig: (next: UiPrefsPayload | null) => void
  private readonly keybindingsRevAcc: Accessor<number | null>
  private readonly setKeybindingsRevSig: (next: number | null) => void
  private readonly uiPrefsStoreInner = createExternalStore<UiPrefsPayload | null>(null)
  private readonly keybindingsRevStoreInner = createExternalStore<number | null>(null)
  private readonly transcriptActivityStoreInner = createExternalStore<TranscriptActivityMap | null>(null)
  private readonly connectionStateAcc: Accessor<DaemonConnectionState>
  private readonly setConnectionState: (next: DaemonConnectionState) => void
  private readonly ensureReachable: () => Promise<unknown>
  private readonly role: SubscribeRole
  private readonly channels?: readonly ChannelName[]
  private readonly subscribesTasks: boolean
  private reconnecting = false
  private readonly signals: OrchestratorSignals

  constructor(
    private readonly client: KobeDaemonClient,
    options: RemoteOrchestratorOptions = {},
  ) {
    const [tasks, setTasks] = createSignal<Task[]>([])
    const [activeTask, setActiveTask] = createSignal<string | null>(null)
    const [update, setUpdate] = createSignal<UpdateInfo | null>(null)
    const [daemonVersion, setDaemonVersion] = createSignal<string | null>(null)
    const [engineState, setEngineState] = createSignal<ReadonlyMap<string, TaskEngineState>>(new Map())
    const [taskJobs, setTaskJobs] = createSignal<ReadonlyMap<string, TaskJobState>>(new Map())
    const [worktreeChanges, setWorktreeChanges] = createSignal<WorktreeChangesMap | null>(null)
    const [transcriptActivity, setTranscriptActivity] = createSignal<TranscriptActivityMap | null>(null)
    const [uiPrefs, setUiPrefs] = createSignal<UiPrefsPayload | null>(null)
    const [keybindingsRev, setKeybindingsRev] = createSignal<number | null>(null)
    const [connectionState, setConnectionState] = createSignal<DaemonConnectionState>("online")
    this.tasksAcc = tasks
    this.setTasks = (next) => setTasks(() => next)
    this.activeTaskAcc = activeTask
    this.setActiveTaskSig = (next) => setActiveTask(() => next)
    this.updateAcc = update
    this.setUpdateSig = (next) => setUpdate(() => next)
    this.daemonVersionAcc = daemonVersion
    this.setDaemonVersionSig = (next) => setDaemonVersion(() => next)
    this.engineStateAcc = engineState
    this.setEngineStateSig = (next) => setEngineState(() => next)
    this.taskJobsAcc = taskJobs
    this.setTaskJobsSig = (next) => setTaskJobs(() => next)
    this.worktreeChangesAcc = worktreeChanges
    this.setWorktreeChangesSig = (next) => setWorktreeChanges(() => next)
    this.transcriptActivityAcc = transcriptActivity
    this.setTranscriptActivitySig = (next) => {
      setTranscriptActivity(() => next)
      this.transcriptActivityStoreInner.set(next)
    }
    this.uiPrefsAcc = uiPrefs
    this.setUiPrefsSig = (next) => {
      setUiPrefs(() => next)
      this.uiPrefsStoreInner.set(next)
    }
    this.keybindingsRevAcc = keybindingsRev
    this.setKeybindingsRevSig = (next) => {
      setKeybindingsRev(() => next)
      this.keybindingsRevStoreInner.set(next)
    }
    this.connectionStateAcc = connectionState
    this.setConnectionState = (next) => setConnectionState(() => next)
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
    this.client.on("*", (frame) => this.handleEvent(frame.name, frame.payload))
    this.client.onLifecycle("close", () => {
      this.setConnectionState("disconnected")
      if (this.role === "pane") {
        logClient("orch", "daemon socket closed — starting non-spawning reconnect loop")
        void this.reconnectLoop()
      }
    })
  }

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
        if (attempt === 1 || attempt % 10 === 0) logClientError("orch-reconnect", err)
        delayMs = Math.min(delayMs * 2, 3000)
      }
    }
    this.reconnecting = false
  }

  async init(): Promise<void> {
    await performInit(
      this.client,
      { role: this.role, channels: this.channels, subscribesTasks: this.subscribesTasks },
      this.signals,
    )
  }

  connectionStateSignal(): Accessor<DaemonConnectionState> {
    return this.connectionStateAcc
  }

  async manualReconnect(): Promise<void> {
    this.client.forceDisconnect()
    await this.ensureReachable()
    await this.init()
  }

  dispose(): void {
    this.client.close()
  }

  tasksSignal(): Accessor<Task[]> {
    return this.tasksAcc
  }

  activeTaskSignal(): Accessor<string | null> {
    return this.activeTaskAcc
  }

  updateSignal(): Accessor<UpdateInfo | null> {
    return this.updateAcc
  }

  daemonVersionSignal(): Accessor<string | null> {
    return this.daemonVersionAcc
  }

  daemonStaleSignal(): Accessor<boolean> {
    return () => isDaemonVersionStale(this.daemonVersionAcc() ?? undefined, CURRENT_VERSION)
  }

  engineStateSignal(): Accessor<ReadonlyMap<string, TaskEngineState>> {
    return this.engineStateAcc
  }

  taskJobsSignal(): Accessor<ReadonlyMap<string, TaskJobState>> {
    return this.taskJobsAcc
  }

  worktreeChangesSignal(): Accessor<WorktreeChangesMap | null> {
    return this.worktreeChangesAcc
  }

  transcriptActivitySignal(): Accessor<TranscriptActivityMap | null> {
    return this.transcriptActivityAcc
  }

  transcriptActivityStore(): ExternalStore<TranscriptActivityMap | null> {
    return this.transcriptActivityStoreInner
  }

  uiPrefsSignal(): Accessor<UiPrefsPayload | null> {
    return this.uiPrefsAcc
  }

  uiPrefsStore(): ExternalStore<UiPrefsPayload | null> {
    return this.uiPrefsStoreInner
  }

  keybindingsRevSignal(): Accessor<number | null> {
    return this.keybindingsRevAcc
  }

  keybindingsRevStore(): ExternalStore<number | null> {
    return this.keybindingsRevStoreInner
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

  listWorktrees(): Promise<readonly WorktreeProject[]> {
    return listWorktreesOp(this.client)
  }

  removeWorktree(path: string, force?: boolean): Promise<void> {
    return removeWorktreeOp(this.client, path, force)
  }

  setActiveTask(id: TaskId | string | null): Promise<void> {
    return setActiveTaskOp(this.client, id)
  }

  private handleEvent(name: string, payload: unknown): void {
    handleOrchestratorEvent(name, payload, this.signals)
  }
}
