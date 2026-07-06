import { type EngineTurnDetector, createEngineTurnDetector } from "@/engine/turn-detector"
import { type PollCadenceConfig, type PollScheduleState, maybeStartScheduledRun } from "@/lib/poll-scheduling"
import { latestTranscriptMtime } from "@/monitor/activity"
import { isRemoteRepoKey } from "@/state/repos"
import { DEFAULT_TASK_VENDOR, type Task, type VendorId } from "@/types/task"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import type { TranscriptActivityPayload } from "./protocol.ts"

export const DEFAULT_TRANSCRIPT_ACTIVITY_TICK_MS = 1_500
export const TRANSCRIPT_ACTIVITY_TIMEOUT_MS = 4_000
export const TRANSCRIPT_ACTIVITY_SLOW_RETRY_MS = 60_000
export const TRANSCRIPT_ACTIVITY_MIN_INTERVAL_MS = 1_500

export interface TranscriptActivityEntry {
  readonly mtimeMs: number
  readonly completionId: string | null
  readonly completionAt: number
}

export function sameTranscriptActivityEntry(a: TranscriptActivityEntry, b: TranscriptActivityEntry): boolean {
  return a.mtimeMs === b.mtimeMs && a.completionId === b.completionId && a.completionAt === b.completionAt
}

export interface TaskLister {
  listTasks(): readonly Task[]
}

export type TranscriptActivityRunner = (
  worktreePath: string,
  vendor: VendorId,
  detector: EngineTurnDetector,
  signal: AbortSignal,
) => Promise<TranscriptActivityEntry>

export async function runTranscriptActivity(
  worktreePath: string,
  vendor: VendorId,
  detector: EngineTurnDetector,
  _signal: AbortSignal,
): Promise<TranscriptActivityEntry> {
  const mtimeMs = await latestTranscriptMtime(vendor, worktreePath)
  const marker = await detector.latestCompletion(worktreePath)
  return { mtimeMs, completionId: marker?.id ?? null, completionAt: marker?.timestampMs ?? 0 }
}

export function trackedWorktrees(tasks: readonly Task[]): Map<string, VendorId> {
  const map = new Map<string, VendorId>()
  for (const task of tasks) {
    if (task.archived) continue
    if (!task.worktreePath) continue
    if (isRemoteRepoKey(task.repo) || isRemoteRepoKey(task.worktreePath)) continue
    if (map.has(task.worktreePath)) continue
    map.set(task.worktreePath, task.vendor ?? DEFAULT_TASK_VENDOR)
  }
  return map
}

interface CollectorEntry extends PollScheduleState {
  vendor: VendorId
  detector: EngineTurnDetector
  value?: TranscriptActivityEntry
}

export interface TranscriptActivityCollectorOptions {
  readonly cadence?: PollCadenceConfig
  readonly run?: TranscriptActivityRunner
  readonly hasSubscribers?: () => boolean
}

export class TranscriptActivityCollector {
  private readonly entries = new Map<string, CollectorEntry>()
  private stopped = false

  constructor(
    private readonly orch: TaskLister,
    private readonly bus: DaemonEventBus,
    private readonly options: TranscriptActivityCollectorOptions = {},
  ) {}

  tick(): void {
    if (this.stopped) return
    if (this.options.hasSubscribers && !this.options.hasSubscribers()) return
    try {
      const tracked = trackedWorktrees(this.orch.listTasks())
      let pruned = false
      for (const path of this.entries.keys()) {
        if (tracked.has(path)) continue
        const entry = this.entries.get(path)
        if (entry?.value) pruned = true
        this.entries.delete(path)
      }
      if (pruned) this.publish()
      for (const [path, vendor] of tracked) this.maybeCollect(path, vendor)
    } catch (err) {
      logDaemonError("transcript-activity", err)
    }
  }

  stop(): void {
    this.stopped = true
  }

  private maybeCollect(worktreePath: string, vendor: VendorId): void {
    let entry = this.entries.get(worktreePath)
    if (!entry) {
      entry = { inFlight: false, nextAllowedAt: 0, vendor, detector: createEngineTurnDetector(vendor) }
      this.entries.set(worktreePath, entry)
    } else if (entry.vendor !== vendor) {
      entry.vendor = vendor
      entry.detector = createEngineTurnDetector(vendor)
    }
    const cadence = this.options.cadence ?? {
      timeoutMs: TRANSCRIPT_ACTIVITY_TIMEOUT_MS,
      slowRetryMs: TRANSCRIPT_ACTIVITY_SLOW_RETRY_MS,
      minIntervalMs: TRANSCRIPT_ACTIVITY_MIN_INTERVAL_MS,
    }
    const run = this.options.run ?? runTranscriptActivity
    const current = entry
    maybeStartScheduledRun(
      current,
      cadence,
      (signal) => run(worktreePath, current.vendor, current.detector, signal),
      (value) => {
        if (this.stopped) return
        if (this.entries.get(worktreePath) !== current) return
        if (current.value && sameTranscriptActivityEntry(current.value, value)) return
        current.value = value
        this.publish()
      },
    )
  }

  private publish(): void {
    const activity: TranscriptActivityPayload["activity"] = {}
    for (const [path, entry] of this.entries) {
      if (entry.value) activity[path] = entry.value
    }
    this.bus.publish("transcript.activity", { activity })
  }
}

export function startTranscriptActivityCollector(
  orch: TaskLister,
  bus: DaemonEventBus,
  tickMs: number = DEFAULT_TRANSCRIPT_ACTIVITY_TICK_MS,
  hasSubscribers?: () => boolean,
): () => void {
  if (tickMs <= 0) return () => {}
  const collector = new TranscriptActivityCollector(orch, bus, { hasSubscribers })
  collector.tick()
  const timer = setInterval(() => collector.tick(), tickMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    collector.stop()
  }
}
