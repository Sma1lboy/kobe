export interface BackpressureSocket {
  write(data: string): boolean
  once(event: "drain", listener: () => void): void
}

export interface ClientWriterOptions {
  readonly highWaterMark?: number
}

export const DEFAULT_WRITE_HIGH_WATER_MARK = 8 * 1024 * 1024

interface QueuedFrame {
  readonly line: string
  readonly bytes: number
  readonly critical: boolean
}

export class ClientWriter {
  private readonly socket: BackpressureSocket
  private readonly highWaterMark: number
  private queue: QueuedFrame[] = []
  private queuedBytes = 0
  private paused = false
  private draining = false
  private droppedFrames = 0

  constructor(socket: BackpressureSocket, options: ClientWriterOptions = {}) {
    this.socket = socket
    this.highWaterMark = options.highWaterMark ?? DEFAULT_WRITE_HIGH_WATER_MARK
  }

  get isPaused(): boolean {
    return this.paused
  }

  get pendingBytes(): number {
    return this.queuedBytes
  }

  get pendingCount(): number {
    return this.queue.length
  }

  get dropped(): number {
    return this.droppedFrames
  }

  write(line: string, critical: boolean): void {
    if (!this.paused) {
      if (this.safeWrite(line)) return
      this.pause()
      return
    }
    this.enqueue({ line, bytes: Buffer.byteLength(line), critical })
  }

  private enqueue(frame: QueuedFrame): void {
    this.queue.push(frame)
    this.queuedBytes += frame.bytes
    if (this.queuedBytes <= this.highWaterMark) return
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
      this.queue.shift()
      this.queuedBytes -= frame.bytes
      if (!ok) {
        this.pause()
        return
      }
    }
  }

  private safeWrite(line: string): boolean {
    try {
      return this.socket.write(line)
    } catch {
      return true
    }
  }
}
