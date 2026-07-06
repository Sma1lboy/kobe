
import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { ensureDaemonReachable } from "@sma1lboy/kobe-daemon/client/daemon-process"
import type { DaemonRpcClient } from "@sma1lboy/kobe-daemon/client/rpc"
import { defaultDaemonSocketPath } from "@sma1lboy/kobe-daemon/daemon/paths"
import {
  type ChannelPayloads,
  DAEMON_PROTOCOL_VERSION,
  type DaemonRequestName,
  MIN_COMPATIBLE_PROTOCOL_VERSION,
  type SerializedTask,
} from "@sma1lboy/kobe-daemon/daemon/protocol"
import { pruneSnapshotAliases, repoSnapshotAliases } from "../src/lib/repo-key.ts"
import { SPA_CHANNEL_SET, SPA_CHANNELS } from "./spa-channels.ts"

const RECONNECT_INTERVAL_MS = 500
const QUIET_RECONNECTS = 20

type EngineStatePayload = ChannelPayloads["engine-state"]
type TaskJobPayload = ChannelPayloads["task.jobs"]
type WorktreeChangeCounts = ChannelPayloads["worktree.changes"]["changes"]
type UiPrefsPayload = ChannelPayloads["ui-prefs"]
type IssueSnapshotPayload = ChannelPayloads["issue.snapshot"]

export interface BridgeSnapshotState {
  tasks: SerializedTask[]
  activeTaskId: string | null
  engineStates: Record<string, EngineStatePayload>
  update: ChannelPayloads["update"]["info"]
  jobs: Record<string, TaskJobPayload>
  worktreeChanges: WorktreeChangeCounts
  issueSnapshots: Record<string, IssueSnapshotPayload>
  deliver: ChannelPayloads["session.deliver"] | null
  uiPrefs: UiPrefsPayload | null
  connected: boolean
}

export interface ChannelEventOut {
  channel: string
  payload: unknown
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class DaemonLink implements DaemonRpcClient {
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

  onEvent(sink: (event: ChannelEventOut) => void): () => void {
    this.eventSinks.add(sink)
    return () => {
      this.eventSinks.delete(sink)
    }
  }

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
    try {
      const hello = (await client.request("hello", {
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        minProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
      })) as { tasks?: SerializedTask[] }
      if (hello.tasks) this.tasks = hello.tasks
      this.engineStates = {}
      this.jobs = {}
      client.on("*", (frame) => this.onFrame(frame.name, frame.payload))
      client.onLifecycle("close", () => this.onDrop(client))
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
        const live = new Set(tasks.map((t) => t.id))
        const kept = Object.entries(this.engineStates).filter(([id]) => live.has(id))
        if (kept.length !== Object.keys(this.engineStates).length) {
          this.engineStates = Object.fromEntries(kept)
        }
        this.issueSnapshots = pruneSnapshotAliases(this.issueSnapshots, tasks)
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
        for (const alias of repoSnapshotAliases(this.tasks, state.repoRoot)) {
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
        return
      default:
        break
    }
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
