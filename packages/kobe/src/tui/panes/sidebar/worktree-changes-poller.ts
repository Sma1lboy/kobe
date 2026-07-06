/**
 * Async, self-throttling poller behind the sidebar's per-row `+N −M`
 * worktree-changes chip.
 *
 * Why this exists: `git status` walks the working tree — O(repo size) —
 * so calling the synchronous `readWorktreeChanges` (`spawnSync git
 * status`) from a render path blocks the whole event loop for seconds
 * per tick on a huge repo. The sync helper survives ONLY for one-shot
 * CLI use (`kobe api`); render paths must go through this poller.
 *
 * The scheduling core (per-key Solid signal, in-flight dedupe, adaptive
 * cadence, timeout + hard backoff) is the generic
 * `src/tui/lib/background-poll.ts` — this module is the worktree-changes
 * binding: one async `git status --porcelain=v1` per worktree, parsed
 * into `+N −M` counts. Failure / timeout keeps the last value — the chip
 * goes stale or stays hidden rather than flashing a bogus zero, the same
 * "never error, just hide" contract as the sync helper.
 *
 * Archived rows never call `poll()` at all (Sidebar gates on
 * `task.archived`): an Archives listing must not pay git-status for
 * worktrees the user has shelved — that's the exact original bug.
 *
 * Since issue #6 this poller is the NO-DAEMON FALLBACK only: when a
 * connected daemon advertises the `worktree.changes` channel (one
 * collector in the daemon, pushed counts), the Sidebar renders the pushes
 * and never calls `poll()` here — a pane spawns zero git processes while
 * daemon-connected. The daemon's collector
 * (`kobe-daemon/daemon/worktree-changes-collector.ts`) reuses the same
 * scheduling guards via `src/lib/poll-scheduling.ts`.
 */

import { readOnlyGitProcessEnv } from "@/lib/git-env"
import { computeNextAllowedAt, createBackgroundPoller, spawnCapture } from "../../lib/background-poll"
import { type WorktreeChanges, parsePorcelain, sameWorktreeChanges } from "./worktree-changes"

export { shouldPoll } from "../../lib/background-poll"

/** Kill a git status that runs longer than this; the repo is too big to poll. */
export const POLL_TIMEOUT_MS = 4_000
/** After a timeout, leave the worktree alone for this long before retrying. */
export const SLOW_REPO_RETRY_MS = 60_000
/** Floor between successful polls — matches the sidebar's ~2s tick. */
export const MIN_POLL_INTERVAL_MS = 1_500

const ZERO: WorktreeChanges = { added: 0, deleted: 0 }

const poller = createBackgroundPoller<WorktreeChanges>({
  initial: ZERO,
  // Value-equality so a poll returning the same counts doesn't
  // re-render every visible row each tick.
  equals: sameWorktreeChanges,
  timeoutMs: POLL_TIMEOUT_MS,
  slowRetryMs: SLOW_REPO_RETRY_MS,
  minIntervalMs: MIN_POLL_INTERVAL_MS,
  run: async (worktreePath, signal) => {
    // Same flags + lock policy as the sync helper: porcelain v1, and
    // GIT_OPTIONAL_LOCKS=0 so the read never takes .git/index.lock from
    // under the engine's own commits.
    const res = await spawnCapture("git", ["status", "--porcelain=v1"], {
      cwd: worktreePath,
      env: readOnlyGitProcessEnv(),
      signal,
    })
    if (res.status !== 0) throw new Error("git status failed")
    return parsePorcelain(res.stdout)
  },
})

/**
 * Reactive read of the last known change counts for `worktreePath`.
 * Returns zeros (chip hidden) until a poll has completed.
 */
export function worktreeChanges(worktreePath: string): WorktreeChanges {
  return poller.read(worktreePath)
}

/**
 * When the next poll may start. Pure — exported for unit tests.
 * Timed-out runs back off hard; completed runs scale with their own
 * duration so slow repos self-thin without a special case.
 */
export function nextAllowedAt(startedAt: number, finishedAt: number, timedOut: boolean): number {
  return computeNextAllowedAt(startedAt, finishedAt, timedOut, {
    slowRetryMs: SLOW_REPO_RETRY_MS,
    minIntervalMs: MIN_POLL_INTERVAL_MS,
  })
}

/**
 * Fire-and-forget: maybe start an async `git status` for `worktreePath`.
 * Safe to call from a reactive memo on every tick — the guards make the
 * extra calls free, and a signal update caused by a finishing poll
 * cannot re-trigger an immediate spawn (MIN_POLL_INTERVAL_MS floor).
 */
export function pollWorktreeChanges(worktreePath: string): void {
  poller.poll(worktreePath)
}

/** Test hook: drop all cached entries/backoff state. */
export function resetWorktreeChangesPoller(): void {
  poller.reset()
}
