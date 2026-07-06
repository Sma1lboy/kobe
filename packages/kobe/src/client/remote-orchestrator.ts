/**
 * RemoteOrchestrator (v0.6). Mirror of the slim {@link Orchestrator} that
 * runs in the daemon: same read surface (tasks signal + subscribe), and a
 * write surface forwarding each method as a daemon RPC.
 *
 * File-size-cap split: `performInit`/`handleOrchestratorEvent`
 * (`remote-orchestrator-connect.ts`/`-events.ts`) take an explicit
 * {@link OrchestratorSignals} deps bag — built once in the constructor from
 * the same Solid signals this class's read methods return — instead of
 * closing over `this`. Write methods below are 1-line delegates to
 * `remote-orchestrator-writes.ts`. Wire-payload types/helpers live in
 * `remote-orchestrator-payloads.ts`, re-exported below for existing importers.
 */

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
  // Framework-free twins of the two signals above (issue #15 G3): React
  // hosts subscribe via useSyncExternalStore-compatible stores because
  // solid-js reactivity is DEAD outside browser-conditions/plugin-swapped
  // runtimes (node/vitest and plain `bun` resolve the SSR server build).
  // The setter wrappers below dual-write signal + store — single writer,
  // no drift. Solid consumers keep the accessor facade untouched.
  private readonly uiPrefsStoreInner = createExternalStore<UiPrefsPayload | null>(null)
  private readonly keybindingsRevStoreInner = createExternalStore<number | null>(null)
  private readonly connectionStateAcc: Accessor<DaemonConnectionState>
  private readonly setConnectionState: (next: DaemonConnectionState) => void
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
    this.setTranscriptActivitySig = (next) => setTranscriptActivity(() => next)
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
    // Socket drop flips us to `disconnected`. What happens next depends on
    // the role:
    //   - gui:  STOP here (KOB-38). The host TUI watches this signal, shows
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
        // quietly — do NOT spawn one ourselves.
        if (attempt === 1 || attempt % 10 === 0) logClientError("orch-reconnect", err)
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

  /** Shared active task id (session last switched/entered), pushed live on
   *  `active-task` — every surface highlights the SAME focus (KOB-247). */
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

  /**
   * The daemon's reported BUILD version (from the `hello` handshake), or
   * `null` when unknown — an older daemon that predates the field, or before
   * `init()` has resolved. Distinct from {@link updateSignal} ("a newer kobe
   * exists on npm") — this is "what version is the daemon I'm talking to".
   */
  daemonVersionSignal(): Accessor<string | null> {
    return this.daemonVersionAcc
  }

  /**
   * Derived: is the daemon running a DIFFERENT build than this process
   * (you upgraded the binary but the long-lived daemon — Bun has no
   * hot-reload — is still running old code)? NON-fatal, drives the
   * dismissible restart banner. `false` while unknown, so no false banner
   * pre-handshake or on an old daemon; clears once a restarted daemon
   * reports the matching version.
   */
  daemonStaleSignal(): Accessor<boolean> {
    return () => isDaemonVersionStale(this.daemonVersionAcc() ?? undefined, CURRENT_VERSION)
  }

  /**
   * Per-task engine activity (running / turn-complete / rate-limited /
   * permission-needed / error), pushed live on the daemon's `engine-state`
   * channel from engine hooks. The transient, event-driven counterpart to the
   * lifecycle `tasksSignal()` — the sidebar reads it for real-time badges.
   */
  engineStateSignal(): Accessor<ReadonlyMap<string, TaskEngineState>> {
    return this.engineStateAcc
  }

  /**
   * Long daemon operations currently in flight, keyed by taskId — pushed
   * live on the `task.jobs` channel (today: `ensureWorktree`, minute-class
   * on a huge repo). The Tasks pane reads it to show a "materializing" row
   * state in EVERY attached pane while the blocking RPC runs, not just the
   * one that initiated it. Entries are removed on the terminal phases and
   * pruned against each `task.snapshot` (same leak guard as engine-state).
   */
  taskJobsSignal(): Accessor<ReadonlyMap<string, TaskJobState>> {
    return this.taskJobsAcc
  }

  /**
   * Daemon-collected `+N −M` uncommitted-change counts keyed by worktree
   * path, pushed live on the `worktree.changes` channel (issue #6 — ONE
   * collector in the daemon instead of per-pane git polling). `null` =
   * no daemon-collected data (old daemon without the channel, or before
   * `init()`): the sidebar then falls back to its local poller; non-null
   * means "render pushes, spawn zero git processes".
   *
   * Unlike `engine-state` / `task.jobs` there is NO per-snapshot prune:
   * each push REPLACES the whole map (the daemon publishes the full
   * picture and drops deleted/archived tasks' entries itself on its next
   * tick), so stale keys cannot accumulate in a long-lived pane.
   */
  worktreeChangesSignal(): Accessor<WorktreeChangesMap | null> {
    return this.worktreeChangesAcc
  }

  /**
   * Daemon-collected transcript facts keyed by worktree path, pushed live on
   * the `transcript.activity` channel (perf — deduplicate per-Ops-pane
   * polling): the newest transcript mtime (the `● new` badge source) + the
   * engine-owned latest-completion marker (the ChatTab "done" chip source).
   * `null` = no daemon-collected data (old daemon, or before `init()`): the
   * Ops pane falls back to local probes. Same whole-map-replace semantics as
   * {@link worktreeChangesSignal} (no per-snapshot prune needed).
   */
  transcriptActivitySignal(): Accessor<TranscriptActivityMap | null> {
    return this.transcriptActivityAcc
  }

  /**
   * The persisted visual prefs (theme / transparent / focus accent),
   * pushed live on the daemon's `ui-prefs` channel from its state-file
   * watcher. `null` until the first payload arrives (e.g. before the
   * subscribe replay, or talking to an older daemon without the channel).
   * Consumed by every pane host's boot sequence (`tui/lib/host-boot.tsx`)
   * to re-apply appearance changes live across all task sessions.
   */
  uiPrefsSignal(): Accessor<UiPrefsPayload | null> {
    return this.uiPrefsAcc
  }

  /**
   * Framework-free twin of {@link uiPrefsSignal} for React hosts
   * (`src/tui-react/lib/host-boot.tsx`): a subscribe/get pair that works in
   * every runtime, including ones where solid-js resolves to the inert SSR
   * build. Same values, same nullability, one writer (the setter dual-writes).
   */
  uiPrefsStore(): ExternalStore<UiPrefsPayload | null> {
    return this.uiPrefsStoreInner
  }

  /**
   * The keybindings-file revision, bumped on the daemon's `keybindings`
   * channel whenever `~/.kobe/settings/keybindings.yaml` changes. An opaque
   * token — a consumer re-reads + re-applies the file on each transition.
   * `null` until the first payload. Consumed by host-boot's `UiPrefsSync`
   * to live-reload keys across every pane.
   */
  keybindingsRevSignal(): Accessor<number | null> {
    return this.keybindingsRevAcc
  }

  /** Framework-free twin of {@link keybindingsRevSignal} — see uiPrefsStore. */
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
   *  worktree-management TUI page (`worktree.list`). */
  listWorktrees(): Promise<readonly WorktreeProject[]> {
    return listWorktreesOp(this.client)
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
   * pane + the outer monitor highlight the same task (KOB-247).
   */
  setActiveTask(id: TaskId | string | null): Promise<void> {
    return setActiveTaskOp(this.client, id)
  }

  // --- internals ---

  private handleEvent(name: string, payload: unknown): void {
    handleOrchestratorEvent(name, payload, this.signals)
  }
}
