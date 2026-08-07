/**
 * Per-task ring buffer of recent engine lifecycle events — the data behind
 * the TUI's task event feed (`task.recentEvents` RPC). In-memory only:
 * the feed is a debugging/observability surface, not durable history (the
 * engine transcript is), so a daemon restart starting empty is fine.
 */

import type { EngineActivityDetail } from "./contracts.ts"

export interface RecentEngineEvent {
  readonly kind: string
  readonly tabId?: string
  readonly vendor?: string
  readonly sessionId?: string
  readonly detail?: EngineActivityDetail
  readonly at: number
}

export type EngineEventListener = (event: RecentEngineEvent) => void

const PER_TASK_CAP = 100
/** ponytail: crude LRU on task count; per-entry eviction if this ever matters. */
const TASK_CAP = 100

export class EngineEventLog {
  private readonly byTask = new Map<string, RecentEngineEvent[]>()
  private readonly listeners = new Map<string, Set<EngineEventListener>>()

  append(taskId: string, event: RecentEngineEvent): void {
    let list = this.byTask.get(taskId)
    if (!list) {
      // Re-inserting moves the task to the Map's tail (newest); evict the head.
      if (this.byTask.size >= TASK_CAP) {
        const oldest = this.byTask.keys().next().value
        if (oldest !== undefined) this.byTask.delete(oldest)
      }
      list = []
      this.byTask.set(taskId, list)
    }
    list.push(event)
    if (list.length > PER_TASK_CAP) list.splice(0, list.length - PER_TASK_CAP)
    for (const listener of this.listeners.get(taskId) ?? []) {
      try {
        listener(event)
      } catch {
        // One browser/debug consumer must not break hook ingestion.
      }
    }
  }

  /** Newest last. */
  recent(taskId: string, limit = PER_TASK_CAP): readonly RecentEngineEvent[] {
    const list = this.byTask.get(taskId) ?? []
    return limit >= list.length ? [...list] : list.slice(-limit)
  }

  subscribe(taskId: string, listener: EngineEventListener): () => void {
    let set = this.listeners.get(taskId)
    if (!set) {
      set = new Set()
      this.listeners.set(taskId, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
      if (set?.size === 0) this.listeners.delete(taskId)
    }
  }

  clearTask(taskId: string): void {
    this.byTask.delete(taskId)
  }
}
