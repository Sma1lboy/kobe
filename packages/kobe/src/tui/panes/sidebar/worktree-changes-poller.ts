/**
 * Async, self-throttling poller behind the sidebar's per-row `+N −M`
 * worktree-changes chip.
 *
 * Why this exists (the 30GB-repo freeze): the chip used to call the
 * synchronous `readWorktreeChanges` (`spawnSync git status`) for EVERY
 * row on every ~2s `branchTick`. `git status` walks the working tree —
 * O(repo size) — so a row pointing at a huge repo blocked the whole
 * event loop for seconds per tick, permanently freezing the Tasks pane
 * the moment that row rendered (the Archives view was the reported
 * trigger). The sync helper survives ONLY for one-shot CLI use
 * (`kobe api`); render paths must go through this poller.
 *
 * Shape: one module-level entry per worktree path holding a Solid
 * signal (read by the row's memo) plus scheduling state. `poll()` is
 * fire-and-forget — it spawns git ASYNCHRONOUSLY, so a slow repo costs
 * a background child process, never a frozen UI. Three guards keep the
 * child-process budget sane:
 *
 *   - **in-flight dedupe** — one spawn per worktree at a time; ticks
 *     that land while git is still running are dropped.
 *   - **adaptive cadence** — next poll is allowed only after
 *     `max(MIN_POLL_INTERVAL_MS, 5 × last duration)`: fast repos keep
 *     the 2s tick cadence, slow-but-finishing repos thin out on their
 *     own (a 3s status re-runs at most every 15s).
 *   - **timeout + backoff** — a run exceeding `POLL_TIMEOUT_MS` is
 *     SIGKILLed and the worktree backs off for `SLOW_REPO_RETRY_MS`;
 *     the chip simply keeps its last value (or stays hidden) — same
 *     "never error, just hide" contract as the sync helper.
 *
 * Archived rows never call `poll()` at all (Sidebar gates on
 * `task.archived`): an Archives listing must not pay git-status for
 * worktrees the user has shelved — that's the exact original bug.
 */

import { spawn } from "node:child_process"
import { createSignal } from "solid-js"
import { type WorktreeChanges, parsePorcelain } from "./worktree-changes"

/** Kill a git status that runs longer than this; the repo is too big to poll. */
export const POLL_TIMEOUT_MS = 4_000
/** After a timeout, leave the worktree alone for this long before retrying. */
export const SLOW_REPO_RETRY_MS = 60_000
/** Floor between successful polls — matches the sidebar's ~2s tick. */
export const MIN_POLL_INTERVAL_MS = 1_500

const ZERO: WorktreeChanges = { added: 0, deleted: 0 }

type PollEntry = {
  read: () => WorktreeChanges
  write: (next: WorktreeChanges) => void
  inFlight: boolean
  nextAllowedAt: number
}

const entries = new Map<string, PollEntry>()

function entryFor(worktreePath: string): PollEntry {
  let entry = entries.get(worktreePath)
  if (!entry) {
    // Value-equality so a poll returning the same counts doesn't
    // re-render every visible row each tick.
    const [read, set] = createSignal<WorktreeChanges>(ZERO, {
      equals: (a, b) => a.added === b.added && a.deleted === b.deleted,
    })
    entry = { read, write: (next) => set(next), inFlight: false, nextAllowedAt: 0 }
    entries.set(worktreePath, entry)
  }
  return entry
}

/**
 * Reactive read of the last known change counts for `worktreePath`.
 * Returns zeros (chip hidden) until a poll has completed.
 */
export function worktreeChanges(worktreePath: string): WorktreeChanges {
  if (!worktreePath) return ZERO
  return entryFor(worktreePath).read()
}

/**
 * When the next poll may start. Pure — exported for unit tests.
 * Timed-out runs back off hard; completed runs scale with their own
 * duration so slow repos self-thin without a special case.
 */
export function nextAllowedAt(startedAt: number, finishedAt: number, timedOut: boolean): number {
  if (timedOut) return startedAt + SLOW_REPO_RETRY_MS
  return finishedAt + Math.max(MIN_POLL_INTERVAL_MS, (finishedAt - startedAt) * 5)
}

/** Whether a poll may start now. Pure — exported for unit tests. */
export function shouldPoll(state: { inFlight: boolean; nextAllowedAt: number }, now: number): boolean {
  return !state.inFlight && now >= state.nextAllowedAt
}

/**
 * Fire-and-forget: maybe start an async `git status` for `worktreePath`.
 * Safe to call from a reactive memo on every tick — the guards make the
 * extra calls free, and a signal update caused by a finishing poll
 * cannot re-trigger an immediate spawn (MIN_POLL_INTERVAL_MS floor).
 */
export function pollWorktreeChanges(worktreePath: string): void {
  if (!worktreePath) return
  const entry = entryFor(worktreePath)
  const startedAt = Date.now()
  if (!shouldPoll(entry, startedAt)) return
  entry.inFlight = true

  let out = ""
  let timedOut = false
  let settled = false
  // Same flags + lock policy as the sync helper: porcelain v1, and
  // GIT_OPTIONAL_LOCKS=0 so the read never takes .git/index.lock from
  // under the engine's own commits.
  const child = spawn("git", ["status", "--porcelain=v1"], {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  })
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, POLL_TIMEOUT_MS)

  const finish = (code: number | null): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    entry.nextAllowedAt = nextAllowedAt(startedAt, Date.now(), timedOut)
    entry.inFlight = false
    // Failure / timeout keeps the last value — the chip goes stale or
    // stays hidden rather than flashing a bogus zero.
    if (!timedOut && code === 0) entry.write(parsePorcelain(out))
  }
  child.stdout?.on("data", (chunk: Buffer | string) => {
    out += String(chunk)
  })
  child.on("error", () => finish(1))
  child.on("close", (code) => finish(code))
}

/** Test hook: drop all cached entries/backoff state. */
export function resetWorktreeChangesPoller(): void {
  entries.clear()
}
