/**
 * Daemon-side worktree-changes collector (issue #6).
 *
 * Before this, EVERY pane process polled `git status` itself for the
 * sidebar's per-row `+N −M` chips (`tui/panes/sidebar/worktree-changes-poller.ts`
 * riding `tui/lib/background-poll.ts`) — N panes × M tasks of duplicated
 * background subprocesses doing identical work. The daemon is now the
 * SINGLE collector: one guarded `git status --porcelain=v1` per local
 * worktree, fanned out on the `worktree.changes` channel. Panes render
 * the pushes and spawn ZERO git processes while daemon-connected; the
 * pane-local poller survives only as the no-daemon fallback.
 *
 * The scheduling guards are the SAME ones the TUI poller uses against
 * huge-repo `git status` stalls (shared via `@/lib/poll-scheduling`, extracted from background-poll so
 * the daemon doesn't import the TUI's solid-js signal layer):
 *
 *   - **in-flight dedupe** — one `git status` per worktree at a time;
 *     ticks landing mid-run are dropped.
 *   - **timeout + SIGKILL** — a status walk exceeding
 *     {@link WORKTREE_CHANGES_TIMEOUT_MS} is aborted and the child killed.
 *   - **hard backoff** — a timed-out worktree is left alone for
 *     {@link WORKTREE_CHANGES_SLOW_RETRY_MS} (the repo is too big to poll
 *     at tick cadence).
 *   - **adaptive cadence** — the next run waits
 *     `max(minIntervalMs, 5 × last duration)`, so slow-but-finishing
 *     repos self-thin without a special case.
 *
 * Collection scope: every NON-ARCHIVED task with a LOCAL worktree. Archived
 * tasks are never collected (the Archives view must not pay git-status for
 * shelved worktrees — the original freeze trigger), and remote (`ssh://`)
 * projects are skipped — their worktrees aren't on this filesystem.
 * Deleted/archived tasks' entries DROP from the published map on the next
 * tick. `main` tasks collect like any other (worktreePath = repo root —
 * the PROJECTS rows show the same chip); tasks sharing a worktree path
 * (main rows of the same repo) dedupe naturally on the path key.
 *
 * Publish contract: the FULL map, republished only when membership or a
 * value actually changed — the bus's last-value replay then hands a late
 * subscriber the whole picture in one frame, and unchanged ticks cost
 * subscribers nothing. Reads are `GIT_OPTIONAL_LOCKS=0` (inspect, don't
 * write — never take `.git/index.lock` from under the engine's own
 * commits) and best-effort: a failed/timed-out run keeps the entry's last
 * value, never throws, never publishes garbage.
 */

import { readOnlyGitProcessEnv } from "@/lib/git-env"
import {
  type PollCadenceConfig,
  type PollScheduleState,
  maybeStartScheduledRun,
  spawnCapture,
} from "@/lib/poll-scheduling"
import { isRemoteRepoKey } from "@/state/repos"
import { type WorktreeChanges, parsePorcelain, sameWorktreeChanges } from "@/tui/panes/sidebar/worktree-changes"
import type { Task } from "@/types/task"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import type { WorktreeChangesPayload } from "./protocol.ts"

/** Tick cadence — matches the sidebar's ~2s `branchTick` the pane pollers rode. */
export const DEFAULT_WORKTREE_CHANGES_TICK_MS = 2_000
/** Kill a `git status` that runs longer than this; the repo is too big to poll. */
export const WORKTREE_CHANGES_TIMEOUT_MS = 4_000
/** After a timeout, leave the worktree alone for this long before retrying. */
export const WORKTREE_CHANGES_SLOW_RETRY_MS = 60_000
/** Floor between successful polls per worktree. */
export const WORKTREE_CHANGES_MIN_INTERVAL_MS = 1_500

/** The task-list slice the collector needs — `Orchestrator` satisfies it. */
export interface TaskLister {
  listTasks(): readonly Task[]
}

/**
 * Injectable status runner (tests swap the real `git status` out). Throw /
 * reject to keep the entry's last value.
 */
export type WorktreeStatusRunner = (worktreePath: string, signal: AbortSignal) => Promise<WorktreeChanges>

/** The real runner: async `git status --porcelain=v1`, lock-free read. */
export async function runGitStatus(worktreePath: string, signal: AbortSignal): Promise<WorktreeChanges> {
  // Same flags + lock policy as the pane-side poller this replaces:
  // porcelain v1, and GIT_OPTIONAL_LOCKS=0 so the read never takes
  // .git/index.lock from under the engine's own commits.
  const res = await spawnCapture("git", ["status", "--porcelain=v1"], {
    cwd: worktreePath,
    env: readOnlyGitProcessEnv(),
    signal,
  })
  if (res.status !== 0) throw new Error("git status failed")
  return parsePorcelain(res.stdout)
}

/**
 * The worktree paths the collector tracks: non-archived tasks with a
 * non-empty LOCAL worktree. Remote (`ssh://`) projects are excluded by
 * repo key — their worktrees live on another host. Pure — unit-tested.
 * Returns a Set, so tasks sharing a path (e.g. `main` rows whose
 * worktreePath is the repo root) collapse to one collection slot.
 */
export function trackedWorktreePaths(tasks: readonly Task[]): Set<string> {
  const paths = new Set<string>()
  for (const task of tasks) {
    if (task.archived) continue
    if (!task.worktreePath) continue
    if (isRemoteRepoKey(task.repo) || isRemoteRepoKey(task.worktreePath)) continue
    paths.add(task.worktreePath)
  }
  return paths
}

interface CollectorEntry extends PollScheduleState {
  /** Last successful counts, absent until the first run lands. */
  value?: WorktreeChanges
}

export interface WorktreeChangesCollectorOptions {
  readonly cadence?: PollCadenceConfig
  /** Injectable status runner — tests avoid real git/worktrees. */
  readonly run?: WorktreeStatusRunner
  /**
   * Consumer gate (KOB — idle-daemon collector pause). When supplied and it
   * returns `false`, `tick()` does NO work (no `git status` spawns, no
   * publish) — a gui-less `kobe daemon start` / freshly-respawned `daemon
   * restart` with zero subscribed panes must not run N git walks every 2s
   * for nobody. The timer keeps ticking, so the FIRST tick after a pane
   * subscribes repopulates, and the bus's last-value replay hands that late
   * subscriber the current map. Omit (or return `true`) to collect every
   * tick — the historical behavior, used by tests that drive `tick()`
   * directly.
   */
  readonly hasSubscribers?: () => boolean
}

/**
 * Tick-driven collector. `tick()` is synchronous and never throws: it
 * prunes entries for worktrees no longer tracked (deleted/archived/now-
 * remote tasks), starts guarded status runs for due worktrees, and
 * publishes the full map when — and only when — membership or a value
 * changed. Run completions publish as they land (each is a real change
 * by construction). Exposed as a class so tests drive `tick()` directly
 * with a fake lister/bus/runner; `startWorktreeChangesCollector` is the
 * production interval binding.
 */
export class WorktreeChangesCollector {
  private readonly entries = new Map<string, CollectorEntry>()
  private stopped = false

  constructor(
    private readonly orch: TaskLister,
    private readonly bus: DaemonEventBus,
    private readonly options: WorktreeChangesCollectorOptions = {},
  ) {}

  tick(): void {
    if (this.stopped) return
    // Consumer gate: with zero subscribed panes there is nobody to render
    // the counts, so skip the whole pass — no git spawns, no publish. The
    // first tick once a pane subscribes repopulates the map and the bus
    // replays it to the late subscriber.
    if (this.options.hasSubscribers && !this.options.hasSubscribers()) return
    try {
      const tracked = trackedWorktreePaths(this.orch.listTasks())
      // Prune first: a task deleted/archived since the last tick drops its
      // entry — and, when it had published counts, triggers a republish so
      // subscribers stop showing it.
      let pruned = false
      for (const path of this.entries.keys()) {
        if (tracked.has(path)) continue
        const entry = this.entries.get(path)
        // An in-flight run for a pruned path finishes into a dropped entry
        // object — its completion checks membership before publishing.
        if (entry?.value) pruned = true
        this.entries.delete(path)
      }
      if (pruned) this.publish()
      for (const path of tracked) this.maybeCollect(path)
    } catch (err) {
      logDaemonError("worktree-changes", err)
    }
  }

  /** Stop publishing; in-flight children die with their AbortSignal timers. */
  stop(): void {
    this.stopped = true
  }

  private maybeCollect(worktreePath: string): void {
    let entry = this.entries.get(worktreePath)
    if (!entry) {
      entry = { inFlight: false, nextAllowedAt: 0 }
      this.entries.set(worktreePath, entry)
    }
    const cadence = this.options.cadence ?? {
      timeoutMs: WORKTREE_CHANGES_TIMEOUT_MS,
      slowRetryMs: WORKTREE_CHANGES_SLOW_RETRY_MS,
      minIntervalMs: WORKTREE_CHANGES_MIN_INTERVAL_MS,
    }
    const run = this.options.run ?? runGitStatus
    maybeStartScheduledRun(
      entry,
      cadence,
      (signal) => run(worktreePath, signal),
      (value) => {
        if (this.stopped) return
        // The entry may have been pruned (task deleted/archived) while the
        // status ran — a completion for an untracked path must not resurrect
        // it in the published map.
        if (this.entries.get(worktreePath) !== entry) return
        // Publish-on-change only: a status returning the same counts is a
        // no-op for every subscriber.
        if (entry.value && sameWorktreeChanges(entry.value, value)) return
        entry.value = value
        this.publish()
      },
    )
  }

  private publish(): void {
    const changes: WorktreeChangesPayload["changes"] = {}
    for (const [path, entry] of this.entries) {
      if (entry.value) changes[path] = entry.value
    }
    this.bus.publish("worktree.changes", { changes })
  }
}

/**
 * Start the production collector on an interval. Returns a `stop()` that
 * clears the timer. Pass `tickMs <= 0` to disable (returns a no-op stop) —
 * the same disable convention as the server's other pollers; socket-suite
 * tests use it to keep servers git-free.
 *
 * `hasSubscribers` is the consumer gate (KOB — idle-daemon collector
 * pause): each tick is a no-op while it returns `false`, so a gui-less
 * daemon with zero subscribed panes stops spawning `git status` for
 * nobody. The interval keeps running, so the first tick after a pane
 * subscribes repopulates the cache. Omit to collect unconditionally.
 */
export function startWorktreeChangesCollector(
  orch: TaskLister,
  bus: DaemonEventBus,
  tickMs: number = DEFAULT_WORKTREE_CHANGES_TICK_MS,
  hasSubscribers?: () => boolean,
): () => void {
  if (tickMs <= 0) return () => {}
  const collector = new WorktreeChangesCollector(orch, bus, { hasSubscribers })
  collector.tick()
  const timer = setInterval(() => collector.tick(), tickMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    collector.stop()
  }
}
