/**
 * Daemon link — the bridge's ONE connection to the kobe daemon socket.
 *
 * The bridge is a standalone process (not daemon-hosted), so everything it
 * knows arrives over the wire protocol: `hello` for the handshake, then
 * `subscribe` with `role: "gui"` — a browser attached to kobe is a human
 * looking at it, so the bridge holds the daemon alive exactly like an
 * attached TUI (this replaces the old daemon-internal `webHoldsLifetime`).
 * Channel events keep a local mirror current; the mirror feeds the SSE
 * `snapshot` event so a late browser hydrates in one frame.
 *
 * Reconnect policy: a daemon restart (`kobe daemon restart`, the dev loop)
 * drops the socket. The link first plain-reconnects on a short interval —
 * whoever restarted the daemon is already spawning the new one, and spawning
 * here too would race two daemons onto one tasks.json (the split-brain
 * `kobe doctor` exists for). Only after the quiet retries run dry does it
 * escalate to `ensureDaemonReachable`, which may spawn.
 */

import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { ensureDaemonReachable } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { defaultDaemonSocketPath } from "@sma1lboy/kobe-daemon/daemon/paths"
import {
  type ChannelPayloads,
  DAEMON_PROTOCOL_VERSION,
  type DaemonRequestName,
  MIN_COMPATIBLE_PROTOCOL_VERSION,
  type SerializedTask,
} from "@sma1lboy/kobe-daemon/daemon/protocol"
import { SPA_CHANNEL_SET, SPA_CHANNELS } from "./spa-channels.ts"

const RECONNECT_INTERVAL_MS = 500
/** Spawn-free retries after a drop (~10s) before escalating to a spawn. */
const QUIET_RECONNECTS = 20

type EngineStatePayload = ChannelPayloads["engine-state"]
type TaskJobPayload = ChannelPayloads["task.jobs"]
type WorktreeChangeCounts = ChannelPayloads["worktree.changes"]["changes"]
type UiPrefsPayload = ChannelPayloads["ui-prefs"]
type IssueSnapshotPayload = ChannelPayloads["issue.snapshot"]

/** Full bootstrap state for the SSE `snapshot` event (mirrors the SPA's
 *  BridgeSnapshot in src/lib/types.ts). */
export interface BridgeSnapshotState {
  tasks: SerializedTask[]
  activeTaskId: string | null
  engineStates: Record<string, EngineStatePayload>
  update: ChannelPayloads["update"]["info"]
  /** taskId → in-flight long job. Terminal phases are dropped, so this only
   *  ever carries jobs that are genuinely running right now. */
  jobs: Record<string, TaskJobPayload>
  /** worktreePath → uncommitted +added/−deleted counts (daemon-collected). */
  worktreeChanges: WorktreeChangeCounts
  /** repoRoot → daemon-owned issue state replayed by `issue.snapshot`.
   *  Aliased across each repo's worktree paths so the SPA can look it up by
   *  whichever path it knows. */
  issueSnapshots: Record<string, IssueSnapshotPayload>
  /** Most recent session.deliver event (dispatcher plumbing) — the SPA
   *  dedupes on `at`, so replaying the last one to a late browser is safe. */
  deliver: ChannelPayloads["session.deliver"] | null
  /** The user's persisted visual prefs (theme/sort) — null until replayed. */
  uiPrefs: UiPrefsPayload | null
  connected: boolean
}

/** A channel push, as the bridge serializes it over SSE. */
export interface ChannelEventOut {
  channel: string
  payload: unknown
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Drop trailing slashes (but keep a lone `/`) so path comparisons are stable. */
function normalizedPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path
}

/**
 * The set of paths a repo's `issue.snapshot` should be mirrored under. The
 * daemon keys issues by the repo's main-worktree root, but the SPA may look up
 * a snapshot by a task's `repo` OR its `worktreePath` — so alias the snapshot
 * across every path that resolves to the same repo. Always includes the raw
 * `repoRoot`.
 */
function issueSnapshotAliases(tasks: readonly SerializedTask[], repoRoot: string): string[] {
  const root = normalizedPath(repoRoot)
  const aliases = new Set<string>([repoRoot])
  for (const task of tasks) {
    const taskRepo = normalizedPath(task.repo)
    const taskWorktree = normalizedPath(task.worktreePath)
    if (taskRepo === root || taskWorktree === root) {
      if (task.repo) aliases.add(task.repo)
      if (task.worktreePath) aliases.add(task.worktreePath)
    }
  }
  return [...aliases]
}

/**
 * The minimal link surface the bridge's session/spec routes need — just the
 * RPC call. Extracted so those helpers (and their tests) don't depend on the
 * full {@link DaemonLink} (sockets, reconnect, channel mirror).
 */
export interface RpcLink {
  request<T = unknown>(name: DaemonRequestName, payload?: unknown): Promise<T>
}

export class DaemonLink {
  private client: KobeDaemonClient | null = null
  private closed = false
  private connected = false
  private reconnecting = false
  private readonly eventSinks = new Set<(event: ChannelEventOut) => void>()
  private readonly connectionSinks = new Set<(connected: boolean) => void>()

  private tasks: SerializedTask[] = []
  private activeTaskId: string | null = null
  private engineStates: Record<string, EngineStatePayload> = {}
  private update: ChannelPayloads["update"]["info"] = null
  private jobs: Record<string, TaskJobPayload> = {}
  private worktreeChanges: WorktreeChangeCounts = {}
  private issueSnapshots: Record<string, IssueSnapshotPayload> = {}
  private deliver: ChannelPayloads["session.deliver"] | null = null
  private uiPrefs: UiPrefsPayload | null = null

  /**
   * First connection — may spawn the daemon, like any other kobe front-end
   * boot. Throws if the daemon never comes up, so `kobe web` fails fast
   * instead of serving a dead dashboard. Drops after this are handled by
   * the background reconnect loop.
   */
  async start(): Promise<void> {
    await this.connectOnce(true)
  }

  snapshot(): BridgeSnapshotState {
    return {
      tasks: this.tasks,
      activeTaskId: this.activeTaskId,
      engineStates: this.engineStates,
      update: this.update,
      jobs: this.jobs,
      worktreeChanges: this.worktreeChanges,
      issueSnapshots: this.issueSnapshots,
      deliver: this.deliver,
      uiPrefs: this.uiPrefs,
      connected: this.connected,
    }
  }

  get isConnected(): boolean {
    return this.connected
  }

  async request<T = unknown>(name: DaemonRequestName, payload?: unknown): Promise<T> {
    const client = this.client
    if (!client) throw new Error("kobe daemon is not connected")
    return client.request<T>(name, payload)
  }

  /** Register a sink for channel pushes; returns an unsubscribe. */
  onEvent(sink: (event: ChannelEventOut) => void): () => void {
    this.eventSinks.add(sink)
    return () => {
      this.eventSinks.delete(sink)
    }
  }

  /** Register a sink for daemon connect/disconnect transitions. */
  onConnection(sink: (connected: boolean) => void): () => void {
    this.connectionSinks.add(sink)
    return () => {
      this.connectionSinks.delete(sink)
    }
  }

  close(): void {
    this.closed = true
    this.client?.close()
    this.client = null
  }

  private async connectOnce(allowSpawn: boolean): Promise<void> {
    const socketPath = allowSpawn ? await ensureDaemonReachable() : defaultDaemonSocketPath()
    const client = new KobeDaemonClient(socketPath)
    await client.connect()
    // From here the socket is OPEN: a `hello`/`subscribe` failure (e.g. a
    // protocol-mismatch rejection from an upgraded daemon) must close it
    // before rethrowing into the reconnect loop. Without this, every 500ms
    // retry leaked one connected socket — on BOTH ends: the bridge held the
    // client object alive via its handlers, and the daemon held a
    // ClientState in its `clients` set until the socket actually closed.
    try {
      const hello = (await client.request("hello", {
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        minProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
      })) as { tasks?: SerializedTask[] }
      if (hello.tasks) this.tasks = hello.tasks
      // Per-connection state the subscribe replay rebuilds: engine states and
      // jobs are transient (the daemon replays every non-idle task / in-flight
      // job on subscribe), so a fresh connection starts clean instead of
      // keeping pre-restart badges. worktree.changes is last-value replayed as
      // a full map on subscribe, so it self-heals the same way.
      this.engineStates = {}
      this.jobs = {}
      // Wire handlers BEFORE subscribing so the replay frames are captured.
      client.on("*", (frame) => this.onFrame(frame.name, frame.payload))
      client.onLifecycle("close", () => this.onDrop(client))
      // Ask the daemon for only the channels the SPA consumes — the daemon
      // honors the per-channel filter (`normalizeChannelFilter` + the
      // broadcast gate in server.ts), so unconsumed channels stop at the
      // daemon socket. The bridge-side filter in `onFrame` stays as
      // belt-and-suspenders for an older daemon that predates the filter.
      await client.subscribe({ role: "gui", channels: SPA_CHANNELS })
    } catch (err) {
      client.close()
      throw err
    }
    this.client = client
    this.setConnected(true)
  }

  private onDrop(client: KobeDaemonClient): void {
    if (this.client !== client) return
    this.client = null
    this.setConnected(false)
    if (this.closed || this.reconnecting) return
    this.reconnecting = true
    void this.reconnectLoop().finally(() => {
      this.reconnecting = false
    })
  }

  private async reconnectLoop(): Promise<void> {
    for (let attempt = 0; !this.closed && !this.connected; attempt++) {
      try {
        await this.connectOnce(attempt >= QUIET_RECONNECTS)
      } catch {
        await sleep(RECONNECT_INTERVAL_MS)
      }
    }
  }

  private onFrame(name: string, payload: unknown): void {
    switch (name) {
      case "task.snapshot": {
        const tasks = (payload as ChannelPayloads["task.snapshot"]).tasks
        this.tasks = tasks
        // Sweep the engine-state mirror to the live task set — otherwise it
        // grows forever (a deleted task's trailing idle frame, every lapsed-
        // to-idle task) and bloats the snapshot every fresh browser hydrates
        // from. Mirrors the SPA's pruneByTask. (worktreeChanges is path-keyed
        // and fully replaced per frame; jobs drop terminal phases at source —
        // neither leaks, so only engineStates needs this.)
        const live = new Set(tasks.map((t) => t.id))
        const kept = Object.entries(this.engineStates).filter(([id]) => live.has(id))
        if (kept.length !== Object.keys(this.engineStates).length) {
          this.engineStates = Object.fromEntries(kept)
        }
        break
      }
      case "active-task":
        this.activeTaskId = (payload as ChannelPayloads["active-task"]).taskId
        break
      case "engine-state": {
        const state = payload as EngineStatePayload
        this.engineStates = { ...this.engineStates, [state.taskId]: state }
        break
      }
      case "update":
        this.update = (payload as ChannelPayloads["update"]).info
        break
      case "task.jobs": {
        const job = payload as TaskJobPayload
        if (job.phase === "running") {
          this.jobs = { ...this.jobs, [job.taskId]: job }
        } else {
          const { [job.taskId]: _done, ...rest } = this.jobs
          this.jobs = rest
        }
        break
      }
      case "worktree.changes":
        this.worktreeChanges = (payload as ChannelPayloads["worktree.changes"]).changes
        break
      case "issue.snapshot": {
        const state = payload as IssueSnapshotPayload
        const next = { ...this.issueSnapshots }
        for (const alias of issueSnapshotAliases(this.tasks, state.repoRoot)) {
          next[alias] = { ...state, repoRoot: alias }
        }
        this.issueSnapshots = next
        break
      }
      case "session.deliver":
        this.deliver = payload as ChannelPayloads["session.deliver"]
        break
      case "ui-prefs":
        this.uiPrefs = payload as UiPrefsPayload
        break
      case "daemon.stopping":
        // Lifecycle signal, not a channel — the socket close that follows
        // drives the disconnect path; nothing to mirror or forward.
        return
      default:
        break
    }
    // Forward only the channels the SPA renders. Unconsumed daemon channels
    // (ui-prefs, keybindings) are dropped here so they never hit the SSE
    // fan-out → per-client stringify → browser parse.
    if (!SPA_CHANNEL_SET.has(name)) return
    const event: ChannelEventOut = { channel: name, payload }
    for (const sink of this.eventSinks) sink(event)
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return
    this.connected = connected
    for (const sink of this.connectionSinks) sink(connected)
  }
}
