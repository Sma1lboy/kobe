import {
  type EngineActivityDetail,
  type EngineActivityKind,
  type TaskActivityState,
  reduceActivity,
} from "@/engine/hook-events"
import type { DaemonEventBus } from "./event-bus.ts"
import type { ChannelPayloads } from "./protocol.ts"

export const DEFAULT_ENGINE_STATE_TTL_MS = 10 * 60 * 1000

export function resolveEngineStateTtlMs(): number {
  const raw = process.env.KOBE_ENGINE_STATE_TTL_MS
  if (raw === undefined) return DEFAULT_ENGINE_STATE_TTL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ENGINE_STATE_TTL_MS
}

export type ActivityLivenessProbe = (taskId: string) => Promise<number | undefined>

interface ActivityEntry {
  state: TaskActivityState
  detail?: EngineActivityDetail
  at: number
  lapse?: ReturnType<typeof setTimeout>
}

export type EngineStatePayload = ChannelPayloads["engine-state"]

export class DaemonActivityRegistry {
  private readonly activity = new Map<string, ActivityEntry>()

  constructor(
    private readonly bus: DaemonEventBus,
    private readonly staleMs = resolveEngineStateTtlMs(),
    private readonly now = () => Date.now(),
    private readonly livenessAt: ActivityLivenessProbe = () => Promise.resolve(undefined),
  ) {}

  report(taskId: string, kind: EngineActivityKind, detail?: EngineActivityDetail): void {
    const prev = this.activity.get(taskId)
    if (prev?.lapse) clearTimeout(prev.lapse)
    const state = reduceActivity(prev?.state, kind, detail)
    const at = this.now()
    const entry: ActivityEntry = { state, detail, at }
    if (state !== "idle" && state !== "turn_complete") {
      entry.lapse = this.armLapse(taskId, at)
    }
    this.activity.set(taskId, entry)
    this.bus.publish("engine-state", this.payload(taskId, entry))
  }

  private armLapse(taskId: string, at: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      void this.handleLapse(taskId, at)
    }, this.staleMs)
    timer.unref?.()
    return timer
  }

  private async handleLapse(taskId: string, at: number): Promise<void> {
    const before = this.activity.get(taskId)
    if (!before || before.at !== at) return

    let mtime: number | undefined
    try {
      mtime = await this.livenessAt(taskId)
    } catch {
      mtime = undefined
    }

    const cur = this.activity.get(taskId)
    if (!cur || cur.at !== at) return

    if (mtime !== undefined && mtime > this.now() - this.staleMs) {
      cur.lapse = this.armLapse(taskId, at)
      return
    }

    this.publishIdle(taskId)
  }

  clearTask(taskId: string): void {
    const gone = this.activity.get(taskId)
    if (gone?.lapse) clearTimeout(gone.lapse)
    this.activity.delete(taskId)
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
