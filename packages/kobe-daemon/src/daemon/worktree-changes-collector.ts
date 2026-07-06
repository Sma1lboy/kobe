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

export const DEFAULT_WORKTREE_CHANGES_TICK_MS = 2_000
export const WORKTREE_CHANGES_TIMEOUT_MS = 4_000
export const WORKTREE_CHANGES_SLOW_RETRY_MS = 60_000
export const WORKTREE_CHANGES_MIN_INTERVAL_MS = 1_500

export interface TaskLister {
  listTasks(): readonly Task[]
}

export type WorktreeStatusRunner = (worktreePath: string, signal: AbortSignal) => Promise<WorktreeChanges>

export async function runGitStatus(worktreePath: string, signal: AbortSignal): Promise<WorktreeChanges> {
  const res = await spawnCapture("git", ["status", "--porcelain=v1"], {
    cwd: worktreePath,
    env: readOnlyGitProcessEnv(),
    signal,
  })
  if (res.status !== 0) throw new Error("git status failed")
  return parsePorcelain(res.stdout)
}

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
  value?: WorktreeChanges
}

export interface WorktreeChangesCollectorOptions {
  readonly cadence?: PollCadenceConfig
  readonly run?: WorktreeStatusRunner
  readonly hasSubscribers?: () => boolean
}

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
    if (this.options.hasSubscribers && !this.options.hasSubscribers()) return
    try {
      const tracked = trackedWorktreePaths(this.orch.listTasks())
      let pruned = false
      for (const path of this.entries.keys()) {
        if (tracked.has(path)) continue
        const entry = this.entries.get(path)
        if (entry?.value) pruned = true
        this.entries.delete(path)
      }
      if (pruned) this.publish()
      for (const path of tracked) this.maybeCollect(path)
    } catch (err) {
      logDaemonError("worktree-changes", err)
    }
  }

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
        if (this.entries.get(worktreePath) !== entry) return
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
