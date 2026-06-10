import {
  type EngineActivityDetail,
  type EngineActivityKind,
  type TaskActivityState,
  reduceActivity,
} from "@/engine/hook-events"
import type { DaemonEventBus } from "./event-bus.ts"
import type { ChannelPayloads } from "./protocol.ts"

/** How long a non-idle, non-complete engine-activity state survives with no
 *  follow-up event before lapsing to idle (safety net for a missed Stop/SessionEnd). */
export const DEFAULT_ENGINE_STATE_TTL_MS = 10 * 60 * 1000

export function resolveEngineStateTtlMs(): number {
  const raw = process.env.KOBE_ENGINE_STATE_TTL_MS
  if (raw === undefined) return DEFAULT_ENGINE_STATE_TTL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ENGINE_STATE_TTL_MS
}

interface ActivityEntry {
  state: TaskActivityState
  detail?: EngineActivityDetail
  at: number
  lapse?: ReturnType<typeof setTimeout>
}

export type EngineStatePayload = ChannelPayloads["engine-state"]

/**
 * In-memory, daemon-owned activity registry for hook-driven engine badges.
 *
 * This is UI state, not task lifecycle: it is replayed to subscribers and the
 * web snapshot, but never persisted to tasks.json.
 */
export class DaemonActivityRegistry {
  private readonly activity = new Map<string, ActivityEntry>()

  constructor(
    private readonly bus: DaemonEventBus,
    private readonly staleMs = resolveEngineStateTtlMs(),
    private readonly now = () => Date.now(),
  ) {}

  report(taskId: string, kind: EngineActivityKind, detail?: EngineActivityDetail): void {
    const prev = this.activity.get(taskId)
    if (prev?.lapse) clearTimeout(prev.lapse)
    const state = reduceActivity(prev?.state, kind, detail)
    const at = this.now()
    const entry: ActivityEntry = { state, detail, at }
    // Safety net: an in-flight/blocking/error state that never gets a
    // follow-up event lapses back to idle, so a missed Stop/SessionEnd can't
    // pin a badge forever. A completed turn is already terminal; keep the
    // checkmark visible until the next activity event instead of refreshing
    // itself back to the neutral status circle.
    if (state !== "idle" && state !== "turn_complete") {
      entry.lapse = setTimeout(() => {
        const cur = this.activity.get(taskId)
        if (cur && cur.at === at) this.publishIdle(taskId)
      }, this.staleMs)
      entry.lapse.unref?.()
    }
    this.activity.set(taskId, entry)
    this.bus.publish("engine-state", this.payload(taskId, entry))
  }

  clearTask(taskId: string): void {
    const gone = this.activity.get(taskId)
    if (gone?.lapse) clearTimeout(gone.lapse)
    this.activity.delete(taskId)
    // Publish an explicit idle so every subscriber clears this task's badge.
    // The bus only caches one last value per channel, so this also prevents a
    // stale per-task replay if the id is quickly recreated.
    if (gone) this.bus.publish("engine-state", { taskId, state: "idle", at: this.now() })
  }

  snapshotByTask(): Record<string, EngineStatePayload> {
    const out: Record<string, EngineStatePayload> = {}
    for (const [taskId, entry] of this.activity) out[taskId] = this.payload(taskId, entry)
    return out
  }

  currentNonIdle(): EngineStatePayload[] {
    const out: EngineStatePayload[] = []
    for (const [taskId, entry] of this.activity) {
      if (entry.state !== "idle") out.push(this.payload(taskId, entry))
    }
    return out
  }

  close(): void {
    for (const entry of this.activity.values()) {
      if (entry.lapse) clearTimeout(entry.lapse)
    }
    this.activity.clear()
  }

  private publishIdle(taskId: string): void {
    const entry: ActivityEntry = { state: "idle", at: this.now() }
    this.activity.set(taskId, entry)
    this.bus.publish("engine-state", this.payload(taskId, entry))
  }

  private payload(taskId: string, entry: ActivityEntry): EngineStatePayload {
    return {
      taskId,
      state: entry.state,
      ...(entry.detail ? { detail: entry.detail } : {}),
      at: entry.at,
    }
  }
}
