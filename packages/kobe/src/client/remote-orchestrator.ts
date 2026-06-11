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

import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { logClient, logClientError } from "@sma1lboy/kobe-daemon/client/client-log"
import { ensureDaemonReachable } from "@sma1lboy/kobe-daemon/client/daemon-process"
import {
  DAEMON_PROTOCOL_VERSION,
  MIN_COMPATIBLE_PROTOCOL_VERSION,
  type SerializedTask,
  type SubscribeRole,
  type UiPrefsPayload,
  isDaemonVersionStale,
  isProtocolCompatible,
} from "@sma1lboy/kobe-daemon/daemon/protocol"
import { type Accessor, createEffect, createRoot, createSignal } from "solid-js"
import type { EngineActivityDetail, TaskActivityState } from "../engine/hook-events.ts"
import type { Orchestrator, Unsubscribe } from "../orchestrator/core.ts"
import type { Task, TaskId, TaskStatus, VendorId } from "../types/task.ts"
import { toTaskId } from "../types/task.ts"
import type { AdoptableWorktree } from "../types/worktree.ts"
import { CURRENT_VERSION, type UpdateInfo } from "../version.ts"

/** Per-task engine activity, accumulated from the daemon's `engine-state` channel. */
export interface TaskEngineState {
  readonly state: TaskActivityState
  readonly detail?: EngineActivityDetail
  readonly at: number
}

/**
 * A long daemon operation currently IN FLIGHT for a task, accumulated from
 * the `task.jobs` channel (today: `ensureWorktree` — `git worktree add` is
 * minute-class on a huge repo). Presence in the map means "running"; the
 * terminal phases (`done` / `error`) remove the entry, so a replayed
 * terminal payload to a late subscriber is a harmless no-op. The job's
 * outcome isn't surfaced here — the blocking RPC delivers it to the caller.
 */
export interface TaskJobState {
  readonly kind: "ensureWorktree"
}

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
  /**
   * Subscribe role (KOB). `"gui"` keeps the daemon alive while this
   * orchestrator is connected — pass it only from a real front-end attach
   * (`direct.ts`, the outer monitor). Default `"pane"`: an in-tmux helper
   * (Tasks pane, Ops, settings/new-task windows) subscribes for data but
   * never holds the daemon open after the user quits. See {@link SubscribeRole}.
   */
  readonly role?: SubscribeRole
}

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
  private readonly uiPrefsAcc: Accessor<UiPrefsPayload | null>
  private readonly setUiPrefsSig: (next: UiPrefsPayload | null) => void
  private readonly keybindingsRevAcc: Accessor<number | null>
  private readonly setKeybindingsRevSig: (next: number | null) => void
  private readonly connectionStateAcc: Accessor<DaemonConnectionState>
  private readonly setConnectionState: (next: DaemonConnectionState) => void
  private readonly ensureReachable: () => Promise<unknown>
  private readonly role: SubscribeRole
  /** Guards against stacking multiple reconnect loops (one `close` already
   *  running a retry loop must not spawn a second on the next `close`). */
  private reconnecting = false

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
    this.uiPrefsAcc = uiPrefs
    this.setUiPrefsSig = (next) => setUiPrefs(() => next)
    this.keybindingsRevAcc = keybindingsRev
    this.setKeybindingsRevSig = (next) => setKeybindingsRev(() => next)
    this.connectionStateAcc = connectionState
    this.setConnectionState = (next) => setConnectionState(() => next)
    this.ensureReachable = options.ensureReachable ?? ensureDaemonReachable
    this.role = options.role ?? "pane"
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
    // Send our protocol version so the daemon can reject a mismatch, and
    // verify the daemon's version so an OLD daemon (which predates the
    // server-side check) is caught client-side too — both surface the
    // documented "upgrade your kobe" error instead of cryptic failures.
    const hello = await this.client.request<{
      tasks?: SerializedTask[]
      protocolVersion?: number
      minProtocolVersion?: number
      // The daemon's BUILD version (package.json). Omitted by a daemon that
      // predates the field, in which case it stays unknown → never "stale".
      // Distinct from the protocol versions above: those gate compatibility,
      // this drives the non-fatal stale-build banner (see daemonStaleSignal).
      kobeVersion?: string
      // Forward-compat: the daemon advertises its channel/feature set here.
      // Unused today (we negotiate by version range); declared so the field
      // is typed when a future client starts gating on a capability.
      capabilities?: readonly string[]
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
    // Capture the daemon's BUILD version (NON-fatal — the protocol is already
    // compatible). A patch upgrade keeps the protocol version put, so this is
    // the only signal that the daemon is running stale code in memory; the TUI
    // reads `daemonStaleSignal()` to show a "restart the daemon" banner. An old
    // daemon that omits the field leaves the signal null → never flagged stale.
    // Re-set on every init so a reconnect to a freshly-restarted daemon clears
    // the banner once versions match.
    this.setDaemonVersionSig(typeof hello.kobeVersion === "string" ? hello.kobeVersion : null)
    if (hello.tasks) this.setTasks(hello.tasks.map(deserializeTask))
    // Subscribe to all channels (the daemon replays each channel's current
    // value on connect). We only consume `task.snapshot` here; future
    // channels get their own `client.onChannel(...)` consumers elsewhere.
    // Pass our role so the daemon's lazy-shutdown refcount counts only
    // real front-end attaches (`gui`), not in-tmux helper panes (`pane`).
    await this.client.subscribe({ role: this.role })
    this.setConnectionState("online")
    logClient("orch", `subscribed as ${this.role} (${this.tasksAcc().length} tasks)`)
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
   * Derived: is the daemon running a DIFFERENT build than this process? True
   * only when the daemon reported a version that differs from this client's
   * own {@link CURRENT_VERSION}. NON-fatal — the protocol is still compatible
   * (that's checked separately and would have thrown); this is the "you
   * upgraded the binary but the long-lived daemon is still running old code"
   * case (Bun has no hot-reload). Drives the dismissible restart banner.
   * `false` while the daemon version is unknown, so an old daemon — or the
   * pre-handshake window — never shows a false banner. Clears on its own once
   * a reconnect to a restarted daemon reports the matching version.
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
   * The keybindings-file revision, bumped on the daemon's `keybindings`
   * channel whenever `~/.kobe/settings/keybindings.yaml` changes. An opaque
   * change token — only its transitions matter; a consumer re-reads +
   * re-applies the file on each change. `null` until the first payload
   * (before subscribe replay, or talking to an older daemon without the
   * channel). Consumed by host-boot's `UiPrefsSync` to live-reload keys
   * across every pane.
   */
  keybindingsRevSignal(): Accessor<number | null> {
    return this.keybindingsRevAcc
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

  async moveTask(id: TaskId | string, delta: -1 | 1): Promise<void> {
    await this.client.request("task.move", { taskId: String(id), direction: delta < 0 ? "up" : "down" })
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
      if (Array.isArray(value)) {
        this.setTasks(value.map(deserializeTask))
        this.pruneEngineState(value)
        this.pruneTaskJobs(value)
      }
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
      return
    }
    if (name === "engine-state") {
      const p = payload as { taskId?: string; state?: TaskActivityState; detail?: EngineActivityDetail; at?: number }
      if (typeof p?.taskId !== "string" || typeof p.state !== "string") return
      // Accumulate per-task into a fresh Map (new ref → Solid re-renders).
      const next = new Map(this.engineStateAcc())
      if (p.state === "idle") next.delete(p.taskId)
      else next.set(p.taskId, { state: p.state, detail: p.detail, at: typeof p.at === "number" ? p.at : 0 })
      this.setEngineStateSig(next)
      return
    }
    if (name === "task.jobs") {
      const p = payload as { taskId?: string; kind?: string; phase?: string } | undefined
      if (typeof p?.taskId !== "string" || p.kind !== "ensureWorktree") return
      const current = this.taskJobsAcc()
      if (p.phase === "running") {
        const next = new Map(current)
        next.set(p.taskId, { kind: p.kind })
        this.setTaskJobsSig(next)
        return
      }
      // Terminal phases (`done` / `error`) remove the entry. Skip the signal
      // write when nothing is tracked — a replayed terminal payload to a
      // late subscriber must be a true no-op, not a map-identity churn.
      if ((p.phase === "done" || p.phase === "error") && current.has(p.taskId)) {
        const next = new Map(current)
        next.delete(p.taskId)
        this.setTaskJobsSig(next)
      }
      return
    }
    if (name === "ui-prefs") {
      const p = payload as Partial<UiPrefsPayload> | undefined
      if (typeof p?.theme !== "string") return
      this.setUiPrefsSig({
        theme: p.theme,
        transparentBackground: p.transparentBackground === true,
        focusAccent: typeof p.focusAccent === "string" ? p.focusAccent : null,
        // Older daemons omit `sortMode` → treat as the default ordering.
        sortMode: p.sortMode === "recent" ? "recent" : "default",
        // Older daemons omit `keysCollapsed` → legend expanded.
        keysCollapsed: p.keysCollapsed === true,
      })
      return
    }
    if (name === "keybindings") {
      const p = payload as { rev?: number } | undefined
      if (typeof p?.rev !== "number") return
      this.setKeybindingsRevSig(p.rev)
      return
    }
  }

  /**
   * Drop engine-state entries for tasks that no longer exist (leak guard).
   * The `engine-state` channel only removes an entry on an explicit `idle`
   * event for that taskId — a task deleted/pruned while non-idle (running /
   * permission-needed / error, the common delete case) never gets one, so
   * in a long-lived pane process the map grew one stale entry per deleted
   * task, forever. Reconcile against each `task.snapshot` instead: any key
   * absent from the authoritative task list is dead. Benign race: an
   * `engine-state` event arriving before the snapshot that introduces its
   * task would be dropped here — the next engine-state event re-adds it
   * (and in practice the daemon publishes the create snapshot before the
   * engine ever starts). No-op (no signal write) when nothing is stale.
   */
  private pruneEngineState(tasks: readonly SerializedTask[]): void {
    const current = this.engineStateAcc()
    if (current.size === 0) return
    const live = new Set(tasks.map((t) => t.id))
    let next: Map<string, TaskEngineState> | null = null
    for (const key of current.keys()) {
      if (live.has(key)) continue
      if (!next) next = new Map(current)
      next.delete(key)
    }
    if (next) this.setEngineStateSig(next)
  }

  /**
   * Drop task-job entries for tasks that no longer exist — the same leak
   * guard as {@link pruneEngineState}. A `done`/`error` publish normally
   * clears the entry, but a task DELETED while its job runs (or a dropped
   * terminal frame across a reconnect) would otherwise pin a phantom
   * "materializing" row state forever in a long-lived pane process.
   * No-op (no signal write) when nothing is stale.
   */
  private pruneTaskJobs(tasks: readonly SerializedTask[]): void {
    const current = this.taskJobsAcc()
    if (current.size === 0) return
    const live = new Set(tasks.map((t) => t.id))
    let next: Map<string, TaskJobState> | null = null
    for (const key of current.keys()) {
      if (live.has(key)) continue
      if (!next) next = new Map(current)
      next.delete(key)
    }
    if (next) this.setTaskJobsSig(next)
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
