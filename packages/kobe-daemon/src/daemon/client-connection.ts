/**
 * Per-client wire layer of the daemon's Unix-socket transport — the
 * connection state each socket carries, newline-framed request parsing, and
 * the backpressure-aware write/broadcast paths. server.ts owns WHAT happens
 * to a request (dispatch, subscribe semantics); this module owns getting
 * frames on and off the wire safely.
 */

import type { Socket } from "node:net"
import type { ClientWriter } from "./client-writer.ts"
import { type ChannelName, type DaemonFrame, frameToLine } from "./protocol.ts"

export interface DaemonClientConnection {
  readonly id: number
  readonly connectedAt: Date
}

export type ClientState = DaemonClientConnection & {
  socket: Socket
  /**
   * Backpressure-aware writer for this socket (fix E). Every server→client
   * frame goes through it so a slow/stalled client buffers in a bounded
   * per-client queue (oldest droppable frames shed past the high-water mark)
   * instead of letting Node queue unbounded heap on the long-lived daemon.
   * Lifecycle/response frames are never dropped. See {@link ClientWriter}.
   */
  writer: ClientWriter
  buffer: string
  /** True once the client has called `subscribe` (broadcast target). */
  subscribed: boolean
  /**
   * True only when the client subscribed with `role: "gui"` — a real
   * front-end attach. This is the refcount that gates lazy shutdown; an
   * in-tmux helper pane (`role: "pane"`) is `subscribed` (gets channels)
   * but NOT `holdsLifetime`, so closing it never stops the daemon.
   */
  holdsLifetime: boolean
  /**
   * Per-channel subscribe filter (KOB — per-channel subscribe). `null` =
   * "no filter, deliver every channel" (the historical behavior — what a
   * subscriber that omits `channels` gets). A non-null set restricts both
   * the connect-time replay AND every later `broadcast` to the named
   * channels, so a narrow consumer (e.g. host-boot's UiPrefsSync, which
   * only wants `ui-prefs` + `keybindings`) no longer receives — and
   * deserializes — the full `task.snapshot` fan-out it never reads. The
   * `daemon.stopping` lifecycle frame is NOT a channel and bypasses this
   * filter (every subscriber must learn the daemon is going down).
   */
  channels: ReadonlySet<ChannelName> | null
}

/**
 * Critical frames are never dropped under backpressure (fix E): the
 * `daemon.stopping` lifecycle signal (every client must learn the daemon is
 * going down) and every RPC `response` (dropping one would hang the client's
 * pending request). Channel `event` frames are droppable — the bus
 * last-value-coalesces them, so a dropped intermediate is superseded by the
 * next publish.
 */
function isCriticalFrame(frame: DaemonFrame): boolean {
  if (frame.type === "event") return frame.name === "daemon.stopping"
  return true
}

export function writeFrame(client: Pick<ClientState, "writer">, frame: DaemonFrame): void {
  client.writer.write(frameToLine(frame), isCriticalFrame(frame))
}

export function broadcast(clients: ReadonlySet<ClientState>, frame: DaemonFrame): void {
  // Serialize ONCE per publish, not once per subscriber: a task.snapshot
  // frame is ~8.5KB at 20 tasks, so N subscribers would otherwise cost N
  // identical JSON.stringify passes per task mutation. The wire bytes are
  // unchanged — every subscriber receives the exact same line.
  //
  // Per-channel filter (KOB — per-channel subscribe): a channel event is
  // skipped for a client whose `channels` filter excludes it, so a narrow
  // consumer no longer receives (nor parses) fan-out it never reads. The
  // `daemon.stopping` lifecycle frame is NOT a channel — it bypasses the
  // filter so every subscriber learns the daemon is going down.
  const channel = frame.type === "event" && frame.name !== "daemon.stopping" ? (frame.name as ChannelName) : null
  // Backpressure (fix E): each client's writer obeys its own socket's drain
  // signal and buffers in a bounded per-client queue, so one slow client can
  // neither stall the fan-out for healthy clients nor grow the daemon heap
  // unbounded. Critical-ness is identical for all clients, so compute it once.
  const critical = isCriticalFrame(frame)
  let line: string | null = null
  for (const client of clients) {
    if (!client.subscribed && frame.type === "event") continue
    if (channel && client.channels && !client.channels.has(channel)) continue
    line ??= frameToLine(frame)
    client.writer.write(line, critical)
  }
}

/**
 * Split the client's accumulated buffer on newlines and hand each complete
 * request frame to `onRequest`. A malformed line (bad JSON / non-request
 * frame) answers with a bare `{ message }` parse-error response — it never
 * carried an Error `name` on the wire, and keeping that here preserves the
 * exact bytes.
 */
export function drainClientBuffer(
  client: ClientState,
  onRequest: (req: Extract<DaemonFrame, { type: "request" }>, client: ClientState) => void,
): void {
  let nl = client.buffer.indexOf("\n")
  while (nl !== -1) {
    const line = client.buffer.slice(0, nl)
    client.buffer = client.buffer.slice(nl + 1)
    if (line.trim().length > 0) {
      try {
        const frame = JSON.parse(line) as DaemonFrame
        if (frame.type !== "request") throw new Error("daemon only accepts request frames from clients")
        onRequest(frame, client)
      } catch (err) {
        writeFrame(client, {
          type: "response",
          id: "parse-error",
          error: { message: err instanceof Error ? err.message : String(err) },
        })
      }
    }
    nl = client.buffer.indexOf("\n")
  }
}
