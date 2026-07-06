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

export type LifecycleEvent = "close"

export class KobeDaemonClient implements DaemonRpcClient {
  private socket: Socket | null = null
  private buffer = ""
  private nextId = 1
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
  private readonly handlers = new Map<DaemonEventName | "*", Set<DaemonEventHandler>>()
  private readonly lifecycleHandlers = new Map<LifecycleEvent, Set<() => void>>()
  private connecting: Promise<void> | null = null
  private disposed = false

  constructor(readonly socketPath: string) {}

  connect(): Promise<void> {
    if (this.socket) return Promise.resolve()
    if (this.disposed) return Promise.reject(new Error("daemon client disposed"))
    if (this.connecting) return this.connecting
    const p = this.openSocket()
    this.connecting = p
    const cleanup = (): void => {
      if (this.connecting === p) this.connecting = null
    }
    p.then(cleanup, cleanup)
    return p
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  close(): void {
    this.disposed = true
    this.socket?.end()
    this.socket = null
    this.failPending()
  }

  forceDisconnect(): void {
    const socket = this.socket
    if (!socket) return
    this.socket = null
    socket.destroy()
    this.failPending()
  }

  private failPending(): void {
    if (this.pending.size === 0) return
    const err = new Error("daemon connection closed")
    for (const pending of this.pending.values()) pending.reject(err)
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

  onChannel<C extends ChannelName>(channel: C, handler: (payload: ChannelPayloads[C]) => void): () => void {
    return this.on(channel, (frame) => handler(frame.payload as ChannelPayloads[C]))
  }

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
      const decoder = new StringDecoder("utf8")
      this.buffer = ""
      socket.on("data", (chunk) => this.onData(decoder.write(chunk)))
      socket.on("close", () => this.onSocketClose(socket))
    })
  }

  private onSocketClose(which: Socket): void {
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
    if (frame.error) {
      const err = new Error(frame.error.message)
      if (frame.error.name) err.name = frame.error.name
      pending.reject(err)
    } else pending.resolve(frame.payload)
  }

  private emit(frame: Extract<DaemonFrame, { type: "event" }>): void {
    for (const handler of this.handlers.get(frame.name) ?? []) handler(frame)
    for (const handler of this.handlers.get("*") ?? []) handler(frame)
  }
}
