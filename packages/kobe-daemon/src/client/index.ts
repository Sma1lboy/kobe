import { type Socket, connect } from "node:net"
import { StringDecoder } from "node:string_decoder"
import {
  type ChannelName,
  type ChannelPayloads,
  type DaemonEventName,
  type DaemonFrame,
  type DaemonRequestName,
  type SubscribeRole,
  frameToLine,
} from "../daemon/protocol.ts"
import { logClientError } from "./client-log.ts"
import type { DaemonRpcClient } from "./rpc.ts"

export type DaemonEventHandler = (frame: Extract<DaemonFrame, { type: "event" }>) => void

/**
 * A daemon RPC exceeded its per-request deadline: the socket accepted the
 * request but never sent a response frame. This is the WEDGED-daemon signal
 * on a live connection (process alive, socket open, not servicing) — distinct
 * from a normal `close`. The client force-disconnects on it so the wedge is
 * converted into the ordinary disconnected→reconnect lifecycle instead of a
 * silently-hung promise.
 */
export class RpcTimeoutError extends Error {
  constructor(name: string, timeoutMs: number) {
    super(`daemon rpc "${name}" timed out after ${timeoutMs}ms (daemon wedged?)`)
    this.name = "RpcTimeoutError"
  }
}

/**
 * Default per-request deadline. A healthy daemon answers writes in well under
 * a second; 20s is a wide margin for a busy-but-live daemon. Requests that can
 * legitimately run for minutes are exempted by name below, not by this value.
 * `KOBE_RPC_TIMEOUT_MS` overrides it (0/negative disables the deadline) — an
 * operator escape hatch and the test seam for the wedged-daemon path.
 */
function rpcTimeoutMs(): number {
  const raw = process.env.KOBE_RPC_TIMEOUT_MS?.trim()
  if (raw) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return 20_000
}

/**
 * RPCs that do git worktree work and/or forge lookups (ls-remote, gh PR
 * states) — legitimately minute-scale, so the deadline is disabled for them.
 * Everything else (task.create/status/delete/rename/… — the write surface the
 * TUI drives interactively) gets the default deadline.
 */
const RPC_TIMEOUT_EXEMPT: ReadonlySet<DaemonRequestName> = new Set<DaemonRequestName>([
  "task.ensureWorktree",
  "task.ensureMain",
  "worktree.discoverAdoptable",
  "worktree.adopt",
  "worktree.reconcile",
  "worktree.archiveRemoved",
  "worktree.list",
  "worktree.remove",
])

/**
 * Single connection-lifecycle hook — fires when the socket transitions from
 * open to closed for ANY reason (daemon died, kernel dropped the socket,
 * manual `forceDisconnect`). The host TUI subscribes to this and prompts
 * the user "Restart daemon or Quit?". Reconnect is user-driven from that
 * prompt; the client does not auto-retry.
 *
 * Why no auto-reconnect: a kobe daemon dropping under a still-attached
 * client is rare and never transient. The daemon's refcounted lazy
 * shutdown (AGENTS.md "Daemon lifecycle") only self-stops once the LAST
 * subscriber is gone — so a live client never has the daemon vanish from
 * under it for that reason. The user is the one who decides to restart,
 * so popping a modal beats a backoff loop that just delays the same prompt.
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
export class KobeDaemonClient implements DaemonRpcClient {
  private socket: Socket | null = null
  private buffer = ""
  private nextId = 1
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >()
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

  /** True after {@link close} — a deliberately torn-down client that must
   *  not be revived. The pane reconnect loop checks this to stop retrying
   *  once its host is disposing. */
  get isDisposed(): boolean {
    return this.disposed
  }

  close(): void {
    this.disposed = true
    this.socket?.end()
    this.socket = null
    // Reject in-flight requests NOW. `onSocketClose` can't do it for us:
    // its stale-close guard sees `this.socket === null` (we just nulled it)
    // and returns early, so without this the `pending` map retained every
    // unanswered request — promise, resolver closures, payload — for the
    // life of the client object (a leak that grew with each teardown that
    // raced an in-flight RPC).
    this.failPending()
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
    // Same rationale as `close()`: the destroyed socket's close event hits
    // `onSocketClose` with `this.socket` already null, so the guard skips
    // the pending sweep. A long-lived TUI client calls this on EVERY manual
    // reconnect — leaked entries would accumulate across reconnects.
    this.failPending()
  }

  /** Reject + clear every in-flight request (connection is gone for good). */
  private failPending(): void {
    if (this.pending.size === 0) return
    const err = new Error("daemon connection closed")
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
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
   * Typed sugar over {@link on} for a push channel: the handler
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
   *
   * `role` declares whether this subscriber HOLDS the daemon alive (KOB):
   * `"gui"` for a real front-end attach, `"pane"` (default) for an in-tmux
   * helper pane that receives channels but must not keep the daemon running
   * after the user quits. See {@link SubscribeRole}.
   */
  subscribe(opts: { channels?: readonly ChannelName[]; role?: SubscribeRole } = {}): Promise<unknown> {
    const payload: { channels?: readonly ChannelName[]; role?: SubscribeRole } = {}
    if (opts.channels) payload.channels = opts.channels
    if (opts.role) payload.role = opts.role
    return this.request("subscribe", payload)
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
      const entry: {
        resolve: (value: unknown) => void
        reject: (err: Error) => void
        timer?: ReturnType<typeof setTimeout>
      } = { resolve: (value) => resolve(value as T), reject }
      // Per-request deadline: without it a WEDGED daemon (socket open, no
      // response frame) leaves this promise pending FOREVER — the caller's
      // .catch never fires, connectionState stays a misleading "online", and
      // the UI silently freezes on stale state. On expiry we reject with
      // RpcTimeoutError and force-disconnect, routing the wedge into the same
      // close→disconnected→reconnect recovery path a crashed daemon takes.
      const timeoutMs = rpcTimeoutMs()
      if (timeoutMs > 0 && !RPC_TIMEOUT_EXEMPT.has(name)) {
        entry.timer = setTimeout(() => this.onRequestTimeout(id, name, timeoutMs), timeoutMs)
      }
      this.pending.set(id, entry)
    })
    socket.write(frameToLine({ type: "request", id, name, payload }))
    return promise
  }

  /** A pending request blew its deadline: reject it, then tear down the
   *  (wedged) socket so the client re-enters its ordinary reconnect flow. */
  private onRequestTimeout(id: string, name: DaemonRequestName, timeoutMs: number): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.reject(new RpcTimeoutError(name, timeoutMs))
    // forceDisconnect() nulls `this.socket` BEFORE destroy(), so the OS close
    // event hits onSocketClose with the stale guard tripped and NO lifecycle
    // "close" is emitted — connectionState would stay stuck on "online".
    // Emit it explicitly here so a wedge converges on the same recovery
    // semantics (disconnected → reconnect) as a normal socket drop.
    this.forceDisconnect()
    this.emitLifecycle("close")
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath)
      this.socket = socket
      const onConnect = () => {
        socket.off("error", onError)
        // Post-connect socket errors (EPIPE writing to a peer that's mid-
        // exit, ECONNRESET) must NOT become unhandled 'error' events — an
        // un-listened 'error' crashes the process. Destroying routes the
        // failure through the 'close' handler below, which rejects every
        // pending request; callers' own catch blocks take it from there.
        socket.on("error", () => socket.destroy())
        resolve()
      }
      const onError = (err: Error) => {
        socket.off("connect", onConnect)
        if (this.socket === socket) this.socket = null
        reject(err)
      }
      socket.once("connect", onConnect)
      socket.once("error", onError)
      // A fresh decoder + line buffer per socket: `StringDecoder` holds a
      // partial multibyte UTF-8 sequence (CJK, em-dash, emoji) across chunk
      // boundaries instead of emitting U+FFFD for the split halves, and a
      // dropped connection's leftover partial line must not bleed into the
      // reconnected socket's first frame.
      const decoder = new StringDecoder("utf8")
      this.buffer = ""
      socket.on("data", (chunk) => this.onData(decoder.write(chunk)))
      socket.on("close", () => this.onSocketClose(socket))
    })
  }

  private onSocketClose(which: Socket): void {
    // Guard against stale close events for an old socket after we've
    // already opened a new one (race between socket.destroy() and the
    // OS delivering the close event for the prior socket).
    if (this.socket !== which) return
    this.socket = null
    this.failPending()
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
    let frame: DaemonFrame
    try {
      frame = JSON.parse(line) as DaemonFrame
    } catch (err) {
      // A single malformed frame must NOT kill the data handler — without
      // this catch the throw propagated out of the socket 'data' callback
      // and silently stopped ALL further event delivery (the socket stays
      // OS-open, so no 'close' fires and the pane just goes deaf — a quiet
      // sync-drift mode). Log it and skip the bad line; the buffer's
      // remaining lines still drain.
      logClientError("client-frame", err)
      return
    }
    if (frame.type === "event") {
      this.emit(frame)
      return
    }
    if (frame.type !== "response") return
    const pending = this.pending.get(frame.id)
    if (!pending) return
    this.pending.delete(frame.id)
    if (pending.timer) clearTimeout(pending.timer)
    if (frame.error) {
      // Preserve the daemon's error NAME (shapeDaemonError puts it on the
      // wire) so callers can branch on e.g. IllegalTransitionError instead
      // of string-matching the message.
      const err = new Error(frame.error.message)
      if (frame.error.name) err.name = frame.error.name
      pending.reject(err)
    } else pending.resolve(frame.payload)
  }

  private emit(frame: Extract<DaemonFrame, { type: "event" }>): void {
    // Per-handler try/catch — same "one bad listener mustn't take the rest
    // down" property `emitLifecycle` already has, and `onLine` already has
    // for JSON.parse. Without it a single throwing subscriber (e.g. a React
    // useSyncExternalStore listener down the setTasks→emit chain) skips the
    // remaining handlers in this frame — including "*" — and the throw exits
    // the socket 'data' callback as an uncaughtException, leaving the socket
    // OS-open (no 'close', no reconnect) and the pane frozen on stale state.
    for (const handler of this.handlers.get(frame.name) ?? []) {
      try {
        handler(frame)
      } catch (err) {
        logClientError("client-event", err)
      }
    }
    for (const handler of this.handlers.get("*") ?? []) {
      try {
        handler(frame)
      } catch (err) {
        logClientError("client-event", err)
      }
    }
  }
}
