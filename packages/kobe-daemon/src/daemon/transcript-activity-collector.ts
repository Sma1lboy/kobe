/**
 * Daemon-side transcript-activity collector (perf — deduplicate
 * per-Ops-pane polling).
 *
 * Before this, EVERY `kobe ops` pane process polled the engine transcript
 * store itself: the `● new` badge readdir'd + stat'd the worktree's
 * transcript dir on a 2.5–20s adaptive timer (`monitor/activity`'s
 * `latestTranscriptMtime`), and the ChatTab "done" chip re-read + re-parsed
 * the newest session JSONL on a 1.5s timer for the engine-owned completion
 * marker (`engine/turn-detector`). Each ChatTab runs its own Ops pane, so a
 * worktree with W tabs paid W× that filesystem churn — at total rest. The
 * daemon is now the SINGLE collector for the SHAREABLE, filesystem half:
 * one guarded probe per local worktree producing `{ mtimeMs, completionId,
 * completionAt }`, fanned out on the `transcript.activity` channel. Panes
 * render the pushes and stat/parse ZERO transcripts while daemon-connected;
 * the pane-local probes survive only as the no-daemon / old-daemon fallback.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  HARD CONSTRAINT — this collector does FILESYSTEM reads ONLY.         ║
 * ║  CLAUDE.md: "daemon shutdown never touches tmux." The per-window      ║
 * ║  `tmux capture-pane` quiescence hashing and the `@kobe_tab_state`     ║
 * ║  `setWindowOption` write STAY in the Ops pane process (ops/host.tsx). ║
 * ║  This file MUST NOT import `@/tmux/*` or anything that drives tmux —  ║
 * ║  it reads the engine's on-disk transcript store and nothing else.    ║
 * ║  Moving capture-pane daemon-side would defeat the whole design.      ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Scheduling reuses the SAME guards as the worktree-changes collector
 * (shared via `@/lib/poll-scheduling`): in-flight dedupe (one probe per
 * worktree at a time), adaptive cadence (next run waits `max(minInterval,
 * 5 × last duration)` so a slow JSONL parse self-thins), and a hard backoff
 * after a timeout. The long-lived per-worktree `EngineTurnDetector` is held
 * across ticks so its mtime-gated memo survives — a quiescent worktree
 * re-stats the transcript dir but does NOT re-parse the JSONL.
 *
 * Collection scope mirrors the git collector: every NON-ARCHIVED task with
 * a LOCAL worktree. Archived tasks and remote (`ssh://`) projects are
 * skipped — their transcripts aren't on this filesystem (or shouldn't be
 * polled). Tasks sharing a worktree path collapse to one slot; the first
 * task in list order picks the vendor deterministically (completion markers
 * are vendor-specific). Deleted/archived tasks' entries DROP on the next
 * tick.
 *
 * Publish contract: the FULL map, republished only when membership or a
 * value actually changed — the bus's last-value replay then hands a late
 * subscriber the whole picture in one frame, and unchanged ticks cost
 * subscribers nothing. Reads are best-effort: a failed/timed-out probe
 * keeps the entry's last value, never throws, never publishes garbage.
 * `stop()` clears the timer only — NO tmux, no held filesystem handles.
 */

import type { DaemonTask as Task, VendorId } from "./contracts.ts"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import type { TranscriptActivityPayload } from "./protocol.ts"
import type {
  DaemonRuntimeAdapter,
  EngineTurnDetectorAdapter as EngineTurnDetector,
  PollCadenceConfig,
  PollScheduleState,
} from "./runtime.ts"

function isRemoteRepoKey(value: string): boolean {
  return value.startsWith("ssh://")
}

function maybeStartScheduledRun<T>(
  state: PollScheduleState,
  cfg: PollCadenceConfig,
  run: (signal: AbortSignal) => Promise<T>,
  onValue: (value: T) => void,
): boolean {
  const startedAt = Date.now()
  if (state.inFlight || startedAt < state.nextAllowedAt) return false
  state.inFlight = true
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  void run(controller.signal)
    .then((value) => {
      if (!controller.signal.aborted) onValue(value)
    })
    .catch(() => {})
    .finally(() => {
      clearTimeout(timer)
      const finishedAt = Date.now()
      state.nextAllowedAt = controller.signal.aborted
        ? startedAt + cfg.slowRetryMs
        : finishedAt + Math.max(cfg.minIntervalMs, (finishedAt - startedAt) * 5)
      state.inFlight = false
    })
  return true
}

/** Tick cadence — matches the Ops pane's 1.5s turn-detector poll (the most responsive consumer). */
export const DEFAULT_TRANSCRIPT_ACTIVITY_TICK_MS = 1_500
/** Kill a probe that runs longer than this; a JSONL parse this slow self-thins via backoff. */
export const TRANSCRIPT_ACTIVITY_TIMEOUT_MS = 4_000
/** After a timeout, leave the worktree alone for this long before retrying. */
export const TRANSCRIPT_ACTIVITY_SLOW_RETRY_MS = 60_000
/** Floor between successful probes per worktree. */
export const TRANSCRIPT_ACTIVITY_MIN_INTERVAL_MS = 1_500

/** One worktree's fs-derived transcript facts — the channel's per-key value. */
export interface TranscriptActivityEntry {
  /** Newest engine-transcript mtime (epoch ms); `0` when no transcript yet. */
  readonly mtimeMs: number
  /** Engine-owned latest-completion marker id; `null` when none/unsupported. */
  readonly completionId: string | null
  /** The marker's timestamp (epoch ms); `0` when absent. */
  readonly completionAt: number
}

/** Entry-wise equality — a probe round-tripping to the same facts is a publish no-op. */
export function sameTranscriptActivityEntry(a: TranscriptActivityEntry, b: TranscriptActivityEntry): boolean {
  return a.mtimeMs === b.mtimeMs && a.completionId === b.completionId && a.completionAt === b.completionAt
}

/** The task-list slice the collector needs — `Orchestrator` satisfies it. */
export interface TaskLister {
  listTasks(): readonly Task[]
}

/**
 * Injectable probe (tests swap the real fs reads out). Receives the
 * worktree's long-lived detector so the default probe reuses its
 * mtime-gated memo across ticks. Throw / reject to keep the entry's last
 * value. The `AbortSignal` is the cadence timeout; fs reads ignore it
 * (there's no child to kill — the adaptive cadence is the real throttle),
 * but it's threaded for parity with the git collector.
 */
export type TranscriptActivityRunner = (
  worktreePath: string,
  vendor: VendorId,
  detector: EngineTurnDetector,
  signal: AbortSignal,
) => Promise<TranscriptActivityEntry>

/**
 * The real probe: the engine-owned latest completion marker AND the newest
 * transcript mtime — from ONE directory scan via `detector.latestActivity`.
 * Before this the probe made TWO independent walks of the same transcript
 * dir per tick (`latestTranscriptMtime` then `latestCompletion`), each doing
 * its own readdir (+ stats / a codex date-tree walk). The detector already
 * stats the newest file while finding the completion, so it surfaces that
 * mtime for free — one listing per probe.
 *
 * Vendors whose detector can't read a transcript store (copilot/custom →
 * `UnknownTurnDetector`) yield no mtime, so we fall back to the vendor's own
 * `latestTranscriptMtime` for them (copilot has a real store the detector
 * doesn't read) — a SINGLE walk, exactly as before for those vendors.
 * Best-effort and FILESYSTEM-only — no tmux, no subprocess.
 */
export async function runTranscriptActivity(
  worktreePath: string,
  vendor: VendorId,
  detector: EngineTurnDetector,
  _signal: AbortSignal,
): Promise<TranscriptActivityEntry> {
  const { marker, mtimeMs } = await detector.latestActivity(worktreePath)
  const resolvedMtime = detector.supportsCompletionMarkers() ? mtimeMs : 0
  return { mtimeMs: resolvedMtime, completionId: marker?.id ?? null, completionAt: marker?.timestampMs ?? 0 }
}

/**
 * The worktree → vendor map the collector tracks: non-archived tasks with a
 * non-empty LOCAL worktree. Remote (`ssh://`) projects are excluded by repo
 * key. Tasks sharing a worktree path collapse; the FIRST task in list order
 * picks the vendor deterministically (completion markers are vendor-specific
 * — a shared path's main row and its children always carry the same vendor
 * in practice, but the first-wins rule keeps the choice stable regardless).
 * A task with no vendor normalizes to {@link DEFAULT_TASK_VENDOR}. Pure —
 * unit-tested.
 */
export function trackedWorktrees(tasks: readonly Task[], defaultVendor: VendorId = "claude"): Map<string, VendorId> {
  const map = new Map<string, VendorId>()
  for (const task of tasks) {
    if (task.archived) continue
    if (!task.worktreePath) continue
    if (isRemoteRepoKey(task.repo) || isRemoteRepoKey(task.worktreePath)) continue
    if (map.has(task.worktreePath)) continue
    map.set(task.worktreePath, task.vendor ?? defaultVendor)
  }
  return map
}

interface CollectorEntry extends PollScheduleState {
  /** The vendor whose transcript store this worktree's probe reads. */
  vendor: VendorId
  /** Long-lived detector — its mtime-gated memo survives across ticks. */
  detector: EngineTurnDetector
  /** Last successful facts, absent until the first probe lands. */
  value?: TranscriptActivityEntry
}

export interface TranscriptActivityCollectorOptions {
  readonly cadence?: PollCadenceConfig
  /** Injectable probe — tests avoid real transcripts/fs. */
  readonly run?: TranscriptActivityRunner
  /**
   * Consumer gate (idle-daemon collector pause) — same contract as the git
   * collector. When supplied and it returns `false`, `tick()` does NO work
   * (no fs probes, no publish): a gui-less daemon with zero subscribed panes
   * must not stat/parse transcripts every 1.5s for nobody. The timer keeps
   * ticking, so the first tick after a pane subscribes repopulates and the
   * bus replays the map to the late subscriber. Omit (or return `true`) to
   * collect every tick — used by tests that drive `tick()` directly.
   */
  readonly hasSubscribers?: () => boolean
  readonly createDetector?: (vendor: VendorId) => EngineTurnDetector
  readonly defaultVendor?: VendorId
}

/**
 * Tick-driven collector. `tick()` is synchronous and never throws: it
 * prunes entries for worktrees no longer tracked (deleted/archived/now-
 * remote tasks), starts guarded probes for due worktrees, and publishes the
 * full map when — and only when — membership or a value changed. Exposed as
 * a class so tests drive `tick()` directly with a fake lister/bus/runner;
 * `startTranscriptActivityCollector` is the production interval binding.
 */
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
    // Consumer gate: with zero subscribed panes there is nobody to render
    // the badge / done chip, so skip the whole pass — no fs probes, no
    // publish. The first tick once a pane subscribes repopulates the map.
    if (this.options.hasSubscribers && !this.options.hasSubscribers()) return
    try {
      const tracked = trackedWorktrees(this.orch.listTasks(), this.options.defaultVendor)
      // Prune first: a task deleted/archived since the last tick drops its
      // entry — and, when it had published facts, triggers a republish so
      // subscribers stop showing it.
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

  /** Stop publishing; in-flight probes resolve into a stopped collector and no-op. */
  stop(): void {
    this.stopped = true
  }

  private maybeCollect(worktreePath: string, vendor: VendorId): void {
    let entry = this.entries.get(worktreePath)
    if (!entry) {
      entry = { inFlight: false, nextAllowedAt: 0, vendor, detector: this.createDetector(vendor) }
      this.entries.set(worktreePath, entry)
    } else if (entry.vendor !== vendor) {
      // A task at this path was re-vendored: swap to the new vendor's
      // detector so completion markers come from the right transcript store.
      entry.vendor = vendor
      entry.detector = this.createDetector(vendor)
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
        // The entry may have been pruned (task deleted/archived) while the
        // probe ran — a completion for an untracked path must not resurrect
        // it in the published map.
        if (this.entries.get(worktreePath) !== current) return
        // Publish-on-change only: a probe returning the same facts is a
        // no-op for every subscriber.
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

  private createDetector(vendor: VendorId): EngineTurnDetector {
    return (
      this.options.createDetector?.(vendor) ?? {
        latestActivity: async () => ({ marker: null, mtimeMs: 0 }),
        supportsCompletionMarkers: () => false,
      }
    )
  }
}

/**
 * Start the production collector on an interval. Returns a `stop()` that
 * clears the timer. Pass `tickMs <= 0` to disable (returns a no-op stop) —
 * the same disable convention as the server's other pollers; socket-suite
 * tests use it to keep servers fs-free.
 *
 * `hasSubscribers` is the consumer gate (idle-daemon collector pause): each
 * tick is a no-op while it returns `false`. The interval keeps running, so
 * the first tick after a pane subscribes repopulates the cache. Omit to
 * collect unconditionally.
 */
export function startTranscriptActivityCollector(
  orch: TaskLister,
  runtime: Pick<DaemonRuntimeAdapter, "createEngineTurnDetector" | "latestTranscriptMtime" | "defaultTaskVendor">,
  bus: DaemonEventBus,
  tickMs: number = DEFAULT_TRANSCRIPT_ACTIVITY_TICK_MS,
  hasSubscribers?: () => boolean,
): () => void {
  if (tickMs <= 0) return () => {}
  const collector = new TranscriptActivityCollector(orch, bus, {
    hasSubscribers,
    createDetector: runtime.createEngineTurnDetector,
    defaultVendor: runtime.defaultTaskVendor,
    run: async (path, vendor, detector, signal) => {
      const { marker, mtimeMs } = await detector.latestActivity(path)
      const resolvedMtime = detector.supportsCompletionMarkers()
        ? mtimeMs
        : await runtime.latestTranscriptMtime(vendor, path)
      void signal
      return { mtimeMs: resolvedMtime, completionId: marker?.id ?? null, completionAt: marker?.timestampMs ?? 0 }
    },
  })
  collector.tick()
  const timer = setInterval(() => collector.tick(), tickMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    collector.stop()
  }
}
