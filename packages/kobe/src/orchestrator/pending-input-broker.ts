/**
 * InMemoryPendingInputBroker — the canonical {@link PendingInputBroker}
 * adapter. Used by the local Orchestrator inside the daemon and (via a
 * re-export from `src/client/`) by RemoteOrchestrator on the TUI side.
 *
 * The same implementation backs both adapters because the broker is
 * pure data — the source of truth differs (orchestrator records vs
 * wire events record), but the bucket shape is identical. See
 * `src/types/pending-input-broker.ts` for the why.
 *
 * Storage: `Map<taskId, Map<requestId, payload>>` for the main bucket,
 * plus a `Map<requestId, tabKey>` side index so `resolve` can return
 * the firing tab without scanning. This mirrors the two maps that
 * used to live inside `Orchestrator` directly (now deleted from there).
 */

import type { PendingInputBroker, PendingInputEntry, ResolvedInputEntry } from "../types/pending-input-broker"
import type { UserInputPayload } from "../types/engine"

export class InMemoryPendingInputBroker implements PendingInputBroker {
  private readonly buckets = new Map<string, Map<string, UserInputPayload>>()
  private readonly requestTab = new Map<string, string>()

  record(taskId: string, tabKey: string, requestId: string, payload: UserInputPayload): void {
    let bucket = this.buckets.get(taskId)
    if (!bucket) {
      bucket = new Map()
      this.buckets.set(taskId, bucket)
    }
    if (bucket.has(requestId)) return
    bucket.set(requestId, payload)
    this.requestTab.set(requestId, tabKey)
  }

  resolve(taskId: string, requestId: string): ResolvedInputEntry | null {
    const bucket = this.buckets.get(taskId)
    const payload = bucket?.get(requestId)
    const tabKey = this.requestTab.get(requestId)
    if (!bucket || !payload || !tabKey) return null
    bucket.delete(requestId)
    if (bucket.size === 0) this.buckets.delete(taskId)
    this.requestTab.delete(requestId)
    return { requestId, payload, tabKey }
  }

  snapshot(taskId: string): PendingInputEntry[] {
    const bucket = this.buckets.get(taskId)
    if (!bucket) return []
    return Array.from(bucket.entries()).map(([requestId, payload]) => ({
      requestId,
      payload,
      // tabKey is always populated alongside the bucket entry — see
      // `record` above. Fallback to empty string only as a defensive
      // last resort; in practice this branch is unreachable.
      tabKey: this.requestTab.get(requestId) ?? "",
    }))
  }

  awaitingTabKeys(): Iterable<string> {
    return this.requestTab.values()
  }

  clearForTask(taskId: string): void {
    const bucket = this.buckets.get(taskId)
    if (!bucket) return
    for (const requestId of bucket.keys()) this.requestTab.delete(requestId)
    this.buckets.delete(taskId)
  }
}
