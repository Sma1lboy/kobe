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

/** Full bootstrap state for the SSE `snapshot` event (mirrors the SPA's
 *  BridgeSnapshot in src/lib/types.ts). */
export interface BridgeSnapshotState {
  tasks: SerializedTask[]
  activeTaskId: string | null
  engineStates: Record<string, EngineStatePayload>
  update: ChannelPayloads["update"]["info"]
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
      // Per-connection state the subscribe replay rebuilds: engine states are
      // transient (the daemon replays every non-idle task on subscribe), so a
      // fresh connection starts clean instead of keeping pre-restart badges.
      this.engineStates = {}
      // Wire handlers BEFORE subscribing so the replay frames are captured.
      client.on("*", (frame) => this.onFrame(frame.name, frame.payload))
      client.onLifecycle("close", () => this.onDrop(client))
      // Ask the daemon for only the channels the SPA consumes. The daemon
      // ignores this filter today (it replays/forwards every channel either
      // way), so the bridge-side filter in `onFrame` is what actually saves
      // the wire+parse cost; this is forward-compat for when the daemon honors
      // the filter and the bytes stop crossing the socket too.
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
      case "task.snapshot":
        this.tasks = (payload as ChannelPayloads["task.snapshot"]).tasks
        break
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
      case "daemon.stopping":
        // Lifecycle signal, not a channel — the socket close that follows
        // drives the disconnect path; nothing to mirror or forward.
        return
      default:
        break
    }
    // Forward only the channels the SPA renders. Unconsumed daemon channels
    // (worktree.changes, ui-prefs, keybindings, task.jobs) are dropped here so
    // they never hit the SSE fan-out → per-client stringify → browser parse.
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
