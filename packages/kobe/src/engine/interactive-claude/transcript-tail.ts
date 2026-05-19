/**
 * Incremental tail of a Claude Code transcript JSONL.
 *
 * Part of KOB-208. Interactive `claude` writes its conversation to
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * one record per line, flushed at turn boundaries (the spike measured
 * an assistant reply landing ~2.6s after the prompt). There is no
 * token-level stream — kobe renders this conversation by tailing the
 * file and converting each newly-appended record into an
 * {@link EngineEvent} (see {@link ./events}).
 *
 * The tail tracks a byte offset. Each poll reads `[offset, size)`,
 * splits on the `\n` byte (which never occurs mid-UTF-8-codepoint), and
 * advances the offset only past *complete* lines — a partial trailing
 * line is re-read on the next poll once the rest has flushed.
 */

import { open, stat } from "node:fs/promises"

/** Return the current size of `filePath` in bytes, or 0 if it does not exist. */
export async function transcriptSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size
  } catch {
    return 0
  }
}

export interface TranscriptTailOpts {
  /** Absolute path to the `<sessionId>.jsonl` transcript. */
  readonly filePath: string
  /** Byte offset to begin tailing from — everything before is treated as history. */
  readonly startOffset: number
  /** Called once per newly-appended JSON record, in file order. */
  readonly onRecord: (record: Record<string, unknown>) => void
  /** Poll interval in ms. Default 250. */
  readonly pollMs?: number
}

/**
 * A running tail. {@link start} begins polling; {@link stop} ends it.
 * Safe to construct, start, and stop once.
 */
export class TranscriptTail {
  private offset: number
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private stopped = false
  private readonly filePath: string
  private readonly onRecord: (record: Record<string, unknown>) => void
  private readonly pollMs: number

  constructor(opts: TranscriptTailOpts) {
    this.filePath = opts.filePath
    this.offset = Math.max(0, opts.startOffset)
    this.onRecord = opts.onRecord
    this.pollMs = opts.pollMs ?? 250
  }

  start(): void {
    if (this.timer || this.stopped) return
    // Kick an immediate poll so a fast turn isn't gated on the interval.
    void this.poll()
    this.timer = setInterval(() => void this.poll(), this.pollMs)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Force one synchronous-ish drain — used by `stop()` paths and tests. */
  async drainNow(): Promise<void> {
    await this.poll()
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return
    this.polling = true
    try {
      const size = await transcriptSize(this.filePath)
      if (size <= this.offset) return
      const length = size - this.offset
      const buf = Buffer.alloc(length)
      const fd = await open(this.filePath, "r")
      try {
        await fd.read(buf, 0, length, this.offset)
      } finally {
        await fd.close()
      }
      const lastNl = buf.lastIndexOf(0x0a)
      if (lastNl === -1) return // no complete line yet — wait for more
      const complete = buf.subarray(0, lastNl).toString("utf8")
      this.offset += lastNl + 1
      for (const line of complete.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let record: unknown
        try {
          record = JSON.parse(trimmed)
        } catch {
          continue // tolerate evolving / partial records
        }
        if (record && typeof record === "object" && !Array.isArray(record)) {
          this.onRecord(record as Record<string, unknown>)
        }
      }
    } catch {
      // Transient FS errors (file briefly absent during a rotation,
      // EBUSY) are swallowed — the next poll retries.
    } finally {
      this.polling = false
    }
  }
}
