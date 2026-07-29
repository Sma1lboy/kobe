/**
 * Newline-delimited JSON client for the daemon unix socket — the push
 * surface the CLI can't give you (live channels). Request names/payloads:
 * kobe-daemon protocol.ts; channel payloads are host-versioned `unknown`.
 */

import { type Socket, createConnection } from "node:net"
import type { DaemonFrame } from "./contract.ts"

export interface KobeSocketOptions {
  /** Defaults to `process.env.KOBE_SOCKET_PATH`. */
  readonly socketPath?: string
}

type Pending = { resolve: (payload: unknown) => void; reject: (err: Error) => void }

export class KobeSocket {
  private sock: Socket | null = null
  private buffer = ""
  private nextId = 1
  private readonly pending = new Map<string, Pending>()
  private eventHandler: ((name: string, payload: unknown) => void) | null = null

  /** Connect; resolves once the socket is up (before any `hello`). */
  connect(opts: KobeSocketOptions = {}): Promise<void> {
    const path = opts.socketPath ?? process.env.KOBE_SOCKET_PATH
    if (!path) return Promise.reject(new Error("KOBE_SOCKET_PATH is not set and no socketPath was given"))
    return new Promise((resolve, reject) => {
      const sock = createConnection(path, () => resolve())
      sock.setEncoding("utf8")
      sock.on("data", (chunk: string) => this.onData(chunk))
      sock.on("error", (err) => {
        reject(err)
        this.failAll(err)
      })
      sock.on("close", () => this.failAll(new Error("daemon socket closed")))
      this.sock = sock
    })
  }

  /** One request → its response payload (rejects on daemon error frames). */
  request<T = unknown>(name: string, payload?: unknown): Promise<T> {
    const sock = this.sock
    if (!sock) return Promise.reject(new Error("not connected — call connect() first"))
    const id = String(this.nextId++)
    const frame: DaemonFrame = { type: "request", id, name, payload }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (p: unknown) => void, reject })
      sock.write(`${JSON.stringify(frame)}\n`)
    })
  }

  /**
   * Subscribe to broadcast channels (omit for all) and receive `event`
   * frames via `handler`. Role is always "pane": an SDK consumer must
   * never hold the daemon's GUI lifetime open.
   */
  async subscribe(handler: (name: string, payload: unknown) => void, channels?: readonly string[]): Promise<void> {
    this.eventHandler = handler
    await this.request("subscribe", { role: "pane", ...(channels ? { channels } : {}) })
  }

  close(): void {
    this.sock?.end()
    this.sock = null
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let idx = this.buffer.indexOf("\n")
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      idx = this.buffer.indexOf("\n")
      if (!line.trim()) continue
      let frame: DaemonFrame
      try {
        frame = JSON.parse(line) as DaemonFrame
      } catch {
        continue // torn/foreign line — skip, never crash the plugin
      }
      if (frame.type === "response") {
        const waiter = this.pending.get(frame.id)
        if (!waiter) continue
        this.pending.delete(frame.id)
        if (frame.error) waiter.reject(new Error(frame.error.message))
        else waiter.resolve(frame.payload)
      } else if (frame.type === "event") {
        this.eventHandler?.(frame.name, frame.payload)
      }
    }
  }

  private failAll(err: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(err)
    this.pending.clear()
  }
}
