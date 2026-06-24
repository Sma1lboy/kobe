/**
 * Daemon-side PR-status poller (KOB-10).
 *
 * For every non-archived task with a real branch + local worktree, shell
 * `gh pr view <branch> --json …` on an interval, map the result to a neutral
 * {@link TaskPRStatus}, and write it through `orch.setPRStatus` → `store.update`
 * → the `task.snapshot` broadcast. Persisting on the Task (rather than a
 * bespoke channel like the worktree-changes collector) means the existing push
 * fans the chip to every Tasks pane + the web board for free, and the status
 * survives a daemon restart. The TUI sidebar renders the check-state chip and
 * — mirroring `useCompletionNotifications` — fires a toast/bell when a task's
 * checks resolve (pending → passing/failing); the poller itself only persists.
 *
 * GitHub only (KOB-10): the runner is `gh`, so remote (`ssh://`) projects and
 * non-GitHub remotes simply yield no PR and are cheap no-ops.
 *
 * Cost control — a per-task backoff map keyed off the outcome:
 *   - has an open PR  → re-poll at tick cadence (checks move).
 *   - merged / closed → {@link SETTLED_BACKOFF_MS} (the PR is done).
 *   - no PR / `gh` unavailable → {@link NO_PR_BACKOFF_MS} (a branch rarely
 *                       sprouts a PR between ticks, and a missing/unauthed `gh`
 *                       must not turn into a per-task spawn every tick).
 *
 * A status is only ever WRITTEN from a successful `gh pr view` (exit 0 with a
 * PR number); any other outcome keeps the last value, so a transient
 * auth/network blip never clobbers a known chip. Best-effort + sequential
 * (gentle on the subprocess budget); a per-task failure is logged, never
 * fatal, never blocks the other tasks in the pass.
 */

import { spawnCapture } from "@/lib/poll-scheduling"
import { GH_PR_VIEW_FIELDS, type GhPrView, mapGhPrView, samePrStatus } from "@/monitor/pr-status"
import type { Orchestrator } from "@/orchestrator/core"
import { isRemoteRepoKey } from "@/state/repos"
import type { Task } from "@/types/task"
import { logDaemonError } from "./crash-log.ts"

/** Default re-scan cadence. PR checks move on the order of seconds-to-minutes;
 * 30s is responsive without hammering `gh` (which hits the network). */
export const DEFAULT_PR_STATUS_POLL_MS = 30_000
/** Re-poll backoff for a branch with no PR yet. */
export const NO_PR_BACKOFF_MS = 5 * 60_000
/** Re-poll backoff once a PR is merged/closed — effectively done. */
export const SETTLED_BACKOFF_MS = 10 * 60_000
/** Kill a `gh pr view` that hangs past this (network stall). */
export const PR_VIEW_TIMEOUT_MS = 10_000

/**
 * The outcome of one `gh pr view`. `pr` = a parsed payload (the only case that
 * writes a status); `empty` = no usable PR — branch has none, `gh` is missing/
 * unauthed, the call timed out, or the JSON didn't parse. We deliberately don't
 * try to distinguish "no PR" from "transient error" (`gh` doesn't give us a
 * clean signal without stderr), so `empty` never clears a known status — it
 * just backs off.
 */
export type PrViewResult = { kind: "pr"; view: GhPrView } | { kind: "empty" }

/** Runs `gh pr view` for a branch in a worktree. Injectable for tests. */
export type PrViewRunner = (worktreePath: string, branch: string) => Promise<PrViewResult>

/** The real runner. Exit 0 with parseable JSON carrying a PR number → `pr`;
 * everything else (no PR, gh missing/unauthed, timeout, bad JSON) → `empty`.
 * `spawnCapture` never throws — a spawn failure resolves with `status: null`. */
export const runGhPrView: PrViewRunner = async (worktreePath, branch) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PR_VIEW_TIMEOUT_MS)
  try {
    const res = await spawnCapture("gh", ["pr", "view", branch, "--json", GH_PR_VIEW_FIELDS], {
      cwd: worktreePath,
      signal: controller.signal,
    })
    if (res.status !== 0) return { kind: "empty" }
    const view = JSON.parse(res.stdout) as GhPrView
    return typeof view.number === "number" ? { kind: "pr", view } : { kind: "empty" }
  } catch {
    return { kind: "empty" } // bad JSON / abort
  } finally {
    clearTimeout(timer)
  }
}

/** A task eligible for PR polling: a real branch on a LOCAL worktree. `main`
 * rows (no branch) and remote projects are skipped. Pure — unit-tested. */
export function isPrPollable(task: Task): boolean {
  if (task.archived) return false
  if (task.kind === "main") return false
  if (!task.branch || !task.worktreePath) return false
  if (isRemoteRepoKey(task.repo) || isRemoteRepoKey(task.worktreePath)) return false
  return true
}

/** Next-allowed-at backoff, keyed by task id. */
export type PrPollSchedule = Map<string, number>

export interface PrStatusPassOptions {
  readonly run: PrViewRunner
  /** `Date.now()`-style clock (ms). Injected so tests are deterministic. */
  readonly now: number
  /** ISO timestamp stamped onto each status. Injected for the same reason. */
  readonly at: string
  /** Per-task backoff state, carried across passes by the live poller. */
  readonly schedule: PrPollSchedule
  readonly tickMs?: number
}

/**
 * Run one polling pass over every eligible task whose backoff has elapsed.
 * Returns the ids whose persisted status actually changed (for tests). Pure
 * orchestrator work — no timers, no `Date.now()`.
 */
export async function runPrStatusPass(orch: Orchestrator, opts: PrStatusPassOptions): Promise<string[]> {
  const tickMs = opts.tickMs ?? DEFAULT_PR_STATUS_POLL_MS
  const changed: string[] = []
  for (const task of orch.listTasks()) {
    if (!isPrPollable(task)) {
      opts.schedule.delete(task.id) // forget backoff for now-ineligible tasks
      continue
    }
    const due = opts.schedule.get(task.id) ?? 0
    if (opts.now < due) continue
    try {
      const result = await opts.run(task.worktreePath, task.branch)
      if (result.kind === "empty") {
        // No usable PR (none yet, or gh unavailable). Keep the last value;
        // back off so a missing/unauthed gh isn't spawned every tick.
        opts.schedule.set(task.id, opts.now + NO_PR_BACKOFF_MS)
        continue
      }
      const next = mapGhPrView(result.view, opts.at)
      // Re-read under the live store (the task may have been archived/deleted
      // during the await) and diff before writing.
      const current = orch.getTask(task.id)
      if (!current) {
        opts.schedule.delete(task.id)
        continue
      }
      if (!samePrStatus(current.prStatus, next ?? undefined)) {
        await orch.setPRStatus(task.id, next)
        changed.push(task.id)
      }
      // A merged/closed PR is done — poll it rarely; an open one tracks checks.
      const settled = next?.lifecycle === "merged" || next?.lifecycle === "closed"
      opts.schedule.set(task.id, opts.now + (settled ? SETTLED_BACKOFF_MS : tickMs))
    } catch (err) {
      logDaemonError("pr-status-poller", err)
      opts.schedule.set(task.id, opts.now + tickMs)
    }
  }
  return changed
}

/**
 * Start the live poller. Returns a `stop()` clearing the interval. Pass
 * `intervalMs <= 0` to disable (no-op stop). `hasSubscribers` is the
 * idle-daemon consumer gate: a tick is a no-op while it returns `false`, so a
 * gui-less daemon never hits the network for nobody. The interval keeps
 * running; the first tick after a pane subscribes repopulates.
 */
export function startPrStatusPoller(
  orch: Orchestrator,
  intervalMs: number = DEFAULT_PR_STATUS_POLL_MS,
  hasSubscribers?: () => boolean,
  run: PrViewRunner = runGhPrView,
): () => void {
  if (intervalMs <= 0) return () => {}
  const schedule: PrPollSchedule = new Map()
  let running = false
  const tick = (): void => {
    if (hasSubscribers && !hasSubscribers()) return
    if (running) return
    running = true
    void runPrStatusPass(orch, { run, now: Date.now(), at: new Date().toISOString(), schedule, tickMs: intervalMs })
      .catch((err) => logDaemonError("pr-status-poller", err))
      .finally(() => {
        running = false
      })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
