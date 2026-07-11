/**
 * Per-client outbound write with backpressure (fix E — daemon socket write
 * backpressure).
 *
 * The daemon is a single long-lived writer that fans channel frames out to
 * every subscribed socket. `net.Socket.write()` returns `false` when the OS
 * send buffer is full (a slow/stalled client), but the data is STILL accepted
 * and buffered in the daemon's heap. Ignoring that return value — and writing
 * the next frame anyway — lets Node queue megabytes per slow client under a
 * fast event stream (many tasks / rapid `engine-state` publishes), so the
 * daemon can grow to GBs and risk OOM.
 *
 * This wrapper makes the daemon obey backpressure PER CLIENT, in isolation:
 *
 *   - **Stop on `false`, resume on `'drain'`.** Once `write()` returns false
 *     we stop handing the socket more bytes and buffer subsequent frames in a
 *     small in-process queue. We resume — flushing the queue in order — only
 *     when the socket emits `'drain'`. One slow client never blocks or slows a
 *     healthy one: each client owns its own writer + queue.
 *
 *   - **Bounded queue, oldest-droppable-first.** If a client never drains, the
 *     queue itself would grow unbounded. So the queue has a byte high-water
 *     mark; when exceeded we drop the OLDEST *droppable* (non-critical) frames
 *     first. Channel frames are droppable because they are last-value-coalesced
 *     by design (a dropped `task.snapshot`/`engine-state` is superseded by the
 *     next one the bus pushes) — the client just skips an intermediate state.
 *
 *   - **Critical frames are never dropped, never reordered.** `daemon.stopping`
 *     (lifecycle) and RPC `response` frames are marked critical: they are kept
 *     in the queue regardless of the high-water mark and surviving frames keep
 *     their relative order, so a single client's stream is never reordered.
 *
 *   - **Best-effort + crash-proof.** A `write()` that throws (socket already
 *     destroyed) is swallowed; the `'close'` handler in server.ts removes the
 *     client. One socket's failure never crashes the daemon or touches others.
 */

/**
 * Minimal socket surface {@link ClientWriter} needs. `net.Socket` satisfies it;
 * tests inject a fake whose `write` returns false then emits `'drain'`.
 */
export interface BackpressureSocket {
  write(data: string): boolean
  once(event: "drain", listener: () => void): void
}

export interface ClientWriterOptions {
  /**
   * Max bytes allowed to sit in the per-client queue before the writer starts
   * dropping the oldest droppable (non-critical) frames. Defaults to
   * {@link DEFAULT_WRITE_HIGH_WATER_MARK}.
   */
  readonly highWaterMark?: number
  /**
   * Called when critical frames alone exceed the queue cap. The caller must
   * tear down the connection: ordered streams such as PTY bytes cannot be
   * dropped or reordered to make room.
   */
  readonly onOverflow?: () => void
}

/** 8 MiB of queued-but-unsent frames per client before we shed droppable load. */
export const DEFAULT_WRITE_HIGH_WATER_MARK = 8 * 1024 * 1024

interface QueuedFrame {
  readonly line: string
  readonly bytes: number
  /** Lifecycle/response frames — kept even when the queue overflows. */
  readonly critical: boolean
}

export class ClientWriter {
  private readonly socket: BackpressureSocket
  private readonly highWaterMark: number
  private readonly onOverflow: (() => void) | undefined
  private queue: QueuedFrame[] = []
  private queuedBytes = 0
  /** True while we are waiting for `'drain'` — every write is queued, not sent. */
  private paused = false
  /** True while a one-shot `'drain'` listener is registered (avoids doubling up). */
  private draining = false
  private droppedFrames = 0
  /** The connection is being torn down after critical-only overflow. */
  private overflowed = false

  constructor(socket: BackpressureSocket, options: ClientWriterOptions = {}) {
    this.socket = socket
    this.highWaterMark = options.highWaterMark ?? DEFAULT_WRITE_HIGH_WATER_MARK
    this.onOverflow = options.onOverflow
  }

  /** True while the socket is saturated and frames are queued, not sent. */
  get isPaused(): boolean {
    return this.paused
  }

  /** Bytes currently buffered in the per-client queue (0 when flowing). */
  get pendingBytes(): number {
    return this.queuedBytes
  }

  /** Frames currently buffered in the per-client queue. */
  get pendingCount(): number {
    return this.queue.length
  }

  /** Total droppable frames shed to stay under the high-water mark. */
  get dropped(): number {
    return this.droppedFrames
  }

  /**
   * Hand a serialized frame line to this client. `critical` frames (lifecycle
   * `daemon.stopping` + RPC responses) are never dropped; non-critical channel
   * frames may be dropped oldest-first once the queue exceeds the high-water
   * mark. Order among surviving frames is always preserved.
   */
  write(line: string, critical: boolean): void {
    if (this.overflowed) return
    if (!this.paused) {
      // Flowing: hand the line straight to the socket. A `false` return means
      // Node's buffer is now full — the line WAS accepted (so we don't requeue
      // it), but we must stop writing more until `'drain'`.
      if (this.safeWrite(line)) return
      this.pause()
      return
    }
    // Saturated: buffer the frame and shed droppable load if we're over budget.
    this.enqueue({ line, bytes: Buffer.byteLength(line), critical })
  }

  private enqueue(frame: QueuedFrame): void {
    this.queue.push(frame)
    this.queuedBytes += frame.bytes
    if (this.queuedBytes <= this.highWaterMark) return
    // Over budget → drop the oldest droppable frames (front→back) until back
    // under the mark or only criticals remain. Criticals are skipped, not
    // dropped, and survivors keep their relative order (no reordering).
    const survivors: QueuedFrame[] = []
    for (const queued of this.queue) {
      if (this.queuedBytes > this.highWaterMark && !queued.critical) {
        this.queuedBytes -= queued.bytes
        this.droppedFrames++
        continue
      }
      survivors.push(queued)
    }
    this.queue = survivors
    if (this.queuedBytes <= this.highWaterMark || !this.onOverflow) return
    // No droppable frames remain. Keeping critical bytes is correct only
    // while the connection can recover; otherwise this queue is unbounded.
    this.overflowed = true
    this.queue = []
    this.queuedBytes = 0
    this.onOverflow()
  }

  private pause(): void {
    if (this.draining) return
    this.paused = true
    this.draining = true
    this.socket.once("drain", () => {
      this.draining = false
      this.paused = false
      this.flush()
    })
  }

  private flush(): void {
    while (this.queue.length > 0) {
      const frame = this.queue[0]
      const ok = this.safeWrite(frame.line)
      // The line was handed to the socket either way → dequeue it.
      this.queue.shift()
      this.queuedBytes -= frame.bytes
      if (!ok) {
        // Saturated again → re-arm the drain wait; the rest stays queued.
        this.pause()
        return
      }
    }
  }

  private safeWrite(line: string): boolean {
    try {
      return this.socket.write(line)
    } catch {
      // Socket already destroyed. Report "accepted" so we neither re-queue nor
      // register a `'drain'` listener that will never fire; the server's
      // `'close'` handler drops the client.
      return true
    }
  }
}
