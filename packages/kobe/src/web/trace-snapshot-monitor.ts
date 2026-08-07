/** Session-keyed trace polling shared by every SSE subscriber in this process. */

import type { EngineHistoryReader } from "../engine/registry.ts"
import type { EngineTrace } from "../types/engine-trace.ts"

export interface TraceSnapshotListener {
  readonly trace: (trace: EngineTrace, revision: number) => void
  readonly error: (error: unknown) => void
}

interface TraceWatch {
  readonly vendor: string
  readonly sessionId: string
  readonly reader: EngineHistoryReader
  readonly listeners: Set<TraceSnapshotListener>
  timer: ReturnType<typeof setInterval>
  revision: number
  snapshot?: EngineTrace
  inFlight: boolean
}

export class TraceSnapshotMonitor {
  private readonly watches = new Map<string, TraceWatch>()

  constructor(
    private readonly readerFor: (vendor: string) => EngineHistoryReader,
    private readonly pollMs = 350,
  ) {}

  subscribe(vendor: string, sessionId: string, listener: TraceSnapshotListener): () => void {
    const key = `${vendor}\0${sessionId}`
    let watch = this.watches.get(key)
    if (!watch) {
      watch = {
        vendor,
        sessionId,
        reader: this.readerFor(vendor),
        listeners: new Set(),
        revision: Number.NaN,
        inFlight: false,
        timer: setInterval(() => void this.refresh(key, false), this.pollMs),
      }
      watch.timer.unref?.()
      this.watches.set(key, watch)
    }
    watch.listeners.add(listener)
    if (watch.snapshot) listener.trace(watch.snapshot, watch.revision)
    else void this.refresh(key, true)

    return () => {
      const current = this.watches.get(key)
      if (!current) return
      current.listeners.delete(listener)
      if (current.listeners.size > 0) return
      clearInterval(current.timer)
      this.watches.delete(key)
    }
  }

  async tick(): Promise<void> {
    await Promise.all([...this.watches.keys()].map((key) => this.refresh(key, false)))
  }

  size(): number {
    return this.watches.size
  }

  private async refresh(key: string, force: boolean): Promise<void> {
    const watch = this.watches.get(key)
    if (!watch || watch.inFlight) return
    watch.inFlight = true
    try {
      const revision = watch.reader.traceRevision ? await watch.reader.traceRevision(watch.sessionId) : 0
      if (!force && (!watch.reader.traceRevision || revision === watch.revision)) return
      const snapshot = watch.reader.readTrace
        ? await watch.reader.readTrace(watch.sessionId)
        : { sessionId: watch.sessionId, turns: [] }
      if (this.watches.get(key) !== watch) return
      watch.revision = revision
      watch.snapshot = snapshot
      for (const listener of watch.listeners) listener.trace(snapshot, revision)
    } catch (error) {
      if (this.watches.get(key) !== watch) return
      for (const listener of watch.listeners) listener.error(error)
    } finally {
      watch.inFlight = false
    }
  }
}
