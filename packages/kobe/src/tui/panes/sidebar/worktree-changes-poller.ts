import { readOnlyGitProcessEnv } from "@/lib/git-env"
import { computeNextAllowedAt, createBackgroundPoller, spawnCapture } from "../../lib/background-poll"
import { type WorktreeChanges, parsePorcelain, sameWorktreeChanges } from "./worktree-changes"

export { shouldPoll } from "../../lib/background-poll"

export const POLL_TIMEOUT_MS = 4_000
export const SLOW_REPO_RETRY_MS = 60_000
export const MIN_POLL_INTERVAL_MS = 1_500

const ZERO: WorktreeChanges = { added: 0, deleted: 0 }

const poller = createBackgroundPoller<WorktreeChanges>({
  initial: ZERO,
  equals: sameWorktreeChanges,
  timeoutMs: POLL_TIMEOUT_MS,
  slowRetryMs: SLOW_REPO_RETRY_MS,
  minIntervalMs: MIN_POLL_INTERVAL_MS,
  run: async (worktreePath, signal) => {
    const res = await spawnCapture("git", ["status", "--porcelain=v1"], {
      cwd: worktreePath,
      env: readOnlyGitProcessEnv(),
      signal,
    })
    if (res.status !== 0) throw new Error("git status failed")
    return parsePorcelain(res.stdout)
  },
})

export function worktreeChanges(worktreePath: string): WorktreeChanges {
  return poller.read(worktreePath)
}

export function nextAllowedAt(startedAt: number, finishedAt: number, timedOut: boolean): number {
  return computeNextAllowedAt(startedAt, finishedAt, timedOut, {
    slowRetryMs: SLOW_REPO_RETRY_MS,
    minIntervalMs: MIN_POLL_INTERVAL_MS,
  })
}

export function pollWorktreeChanges(worktreePath: string): void {
  poller.poll(worktreePath)
}

export function resetWorktreeChangesPoller(): void {
  poller.reset()
}
