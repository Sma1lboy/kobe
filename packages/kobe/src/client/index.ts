import { type Socket, connect } from "node:net"
import {
  type ChannelName,
  type ChannelPayloads,
  type DaemonEventName,
  type DaemonFrame,
  type DaemonRequestName,
  frameToLine,
} from "../daemon/protocol.ts"

export type DaemonEventHandler = (frame: Extract<DaemonFrame, { type: "event" }>) => void

/**
 * Single connection-lifecycle hook — fires when the socket transitions from
 * open to closed for ANY reason (daemon died, kernel dropped the socket,
 * manual `forceDisconnect`). The host TUI subscribes to this and prompts
 * the user "Restart daemon or Quit?". Reconnect is user-driven from that
 * prompt; the client does not auto-retry.
 *
 * Why no auto-reconnect: a kobe daemon dying is rare and never transient
 * (the design has no auto-respawn — `docs/design/daemon.md` §8). The user
 * is the one who decides to restart it, so popping a modal beats a
 * backoff loop that just delays the same prompt.
 */
export type LifecycleEvent = "close"

/**
 * JSON-line client over the kobe daemon's unix socket.
 *
 * Connection model: dumb but explicit. Open a socket via {@link connect},
 * use it until {@link close} (graceful) / {@link forceDisconnect} (kill)
 * / counterparty death drops it. The client emits `close` once on any
 * teardown and stops there. Callers that want to recover open a new
 * socket by calling {@link connect} again — `disposed` after `close()`
 * blocks further connects so a deliberately torn-down client stays torn
 * down.
 */
export class KobeDaemonClient {
  private socket: Socket | null = null
  private buffer = ""
  private nextId = 1
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
  private readonly handlers = new Map<DaemonEventName | "*", Set<DaemonEventHandler>>()
  private readonly lifecycleHandlers = new Map<LifecycleEvent, Set<() => void>>()
  /** Shared in-flight connect promise — avoids parallel openSocket calls
   *  when two callers race on `connect()`. */
  private connecting: Promise<void> | null = null
  /** Manual `close()` was called — block further `connect()` so a torn-down
   *  client can't be silently revived by a stray request. */
  private disposed = false

  constructor(readonly socketPath: string) {}

  connect(): Promise<void> {
    if (this.socket) return Promise.resolve()
    if (this.disposed) return Promise.reject(new Error("daemon client disposed"))
    if (this.connecting) return this.connecting
    const p = this.openSocket()
    this.connecting = p
    // Use `.then(cleanup, cleanup)` instead of `.finally(...)` so the
    // cleanup branch swallows its own outcome — `p.finally(cb)` returns
    // a new promise that rejects in lockstep with `p`, and that returned
    // promise has no handler, surfacing as an unhandled rejection in
    // Bun (the original `p` is still awaited by the caller, so `p`
    // itself is fine — the leak is the `finally`-derived promise).
    const cleanup = (): void => {
      if (this.connecting === p) this.connecting = null
    }
    p.then(cleanup, cleanup)
    return p
  }

  close(): void {
    this.disposed = true
    this.socket?.end()
    this.socket = null
  }

  /**
   * Tear down the live socket without marking the client as disposed.
   * Lets a subsequent {@link connect} re-open. Used by the host TUI's
   * disconnect modal when the user clicks "Restart": kill any half-open
   * socket so the next connect path is clean.
   */
  forceDisconnect(): void {
    const socket = this.socket
    if (!socket) return
    this.socket = null
    socket.destroy()
  }

  on(name: DaemonEventName | "*", handler: DaemonEventHandler): () => void {
    let set = this.handlers.get(name)
    if (!set) {
      set = new Set()
      this.handlers.set(name, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
      if (set?.size === 0) this.handlers.delete(name)
    }
  }

  /**
   * Typed sugar over {@link on} for a push channel (KOB-246): the handler
   * receives the channel's payload, typed from {@link ChannelPayloads}.
   * Adding a consumer for a new channel is just `onChannel("cost", …)`.
   */
  onChannel<C extends ChannelName>(channel: C, handler: (payload: ChannelPayloads[C]) => void): () => void {
    return this.on(channel, (frame) => handler(frame.payload as ChannelPayloads[C]))
  }

  /**
   * Subscribe to the daemon's push channels. Omit `channels` to receive
   * ALL of them (today's behavior); a `channels` filter is accepted for
   * forward-compat (the daemon currently sends everything regardless). The
   * daemon replays each channel's current value on subscribe.
   */
  subscribe(channels?: readonly ChannelName[]): Promise<unknown> {
    return this.request("subscribe", channels ? { channels } : {})
  }

  onLifecycle(name: LifecycleEvent, handler: () => void): () => void {
    let set = this.lifecycleHandlers.get(name)
    if (!set) {
      set = new Set()
      this.lifecycleHandlers.set(name, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
      if (set?.size === 0) this.lifecycleHandlers.delete(name)
    }
  }

  async request<T = unknown>(name: DaemonRequestName, payload?: unknown): Promise<T> {
    await this.connect()
    const socket = this.socket
    if (!socket) throw new Error("daemon connection is not open")
    const id = String(this.nextId++)
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
    })
    socket.write(frameToLine({ type: "request", id, name, payload }))
    return promise
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath)
      this.socket = socket
      const onConnect = () => {
        socket.off("error", onError)
        resolve()
      }
      const onError = (err: Error) => {
        socket.off("connect", onConnect)
        if (this.socket === socket) this.socket = null
        reject(err)
      }
      socket.once("connect", onConnect)
      socket.once("error", onError)
      socket.on("data", (chunk) => this.onData(chunk.toString("utf8")))
      socket.on("close", () => this.onSocketClose(socket))
    })
  }

  private onSocketClose(which: Socket): void {
    // Guard against stale close events for an old socket after we've
    // already opened a new one (race between socket.destroy() and the
    // OS delivering the close event for the prior socket).
    if (this.socket !== which) return
    this.socket = null
    for (const pending of this.pending.values()) pending.reject(new Error("daemon connection closed"))
    this.pending.clear()
    this.emitLifecycle("close")
  }

  private emitLifecycle(name: LifecycleEvent): void {
    for (const handler of this.lifecycleHandlers.get(name) ?? []) {
      try {
        handler()
      } catch (err) {
        // One bad listener mustn't take the rest down.
        // eslint-disable-next-line no-console
        console.error(`[kobe] lifecycle handler for "${name}" threw:`, err)
      }
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl = this.buffer.indexOf("\n")
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (line.trim().length > 0) this.onLine(line)
      nl = this.buffer.indexOf("\n")
    }
  }

  private onLine(line: string): void {
    const frame = JSON.parse(line) as DaemonFrame
    if (frame.type === "event") {
      this.emit(frame)
      return
    }
    if (frame.type !== "response") return
    const pending = this.pending.get(frame.id)
    if (!pending) return
    this.pending.delete(frame.id)
    if (frame.error) pending.reject(new Error(frame.error.message))
    else pending.resolve(frame.payload)
  }

  private emit(frame: Extract<DaemonFrame, { type: "event" }>): void {
    for (const handler of this.handlers.get(frame.name) ?? []) handler(frame)
    for (const handler of this.handlers.get("*") ?? []) handler(frame)
  }
}
