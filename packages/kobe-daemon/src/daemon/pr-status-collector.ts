/**
 * Daemon-side PR-status poller.
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
 * GitHub only: the runner is `gh`, so remote (`ssh://`) projects and
 * non-GitHub remotes simply yield no PR and are cheap no-ops.
 *
 * Cost control — a per-task schedule keyed off the outcome:
 *   - has an open PR  → re-poll at tick cadence (checks move).
 *   - merged / closed → {@link SETTLED_BACKOFF_MS} (the PR is done).
 *   - no PR (gh ran, said none) → {@link NO_PR_BACKOFF_MS} (a branch rarely
 *                       sprouts a PR between ticks).
 *   - `gh`/transport ERROR (missing, unauthed, timeout, network, bad JSON) →
 *                       EXPONENTIAL backoff capped at {@link PR_FAILURE_CAP_MS},
 *                       so a persistent failure (gh missing) stops re-spawning
 *                       at full rate, and the failure kind is logged so it's
 *                       diagnosable rather than silently collapsing to "no PR".
 *   - no GitHub remote (deterministic) → {@link NO_REMOTE_BACKOFF_MS} long idle
 *                       cadence (it will never have a GitHub PR — no retry storm).
 * Every scheduled delay is JITTERED ({@link PR_POLL_JITTER_RATIO}) so N tasks
 * coming due together (a network reconnect re-arming every task) don't poll in
 * lockstep.
 *
 * A status is only ever WRITTEN from a successful `gh pr view` (exit 0 with a
 * PR number); an error or empty keeps the last value, so a transient
 * auth/network blip never clobbers a known chip. Best-effort + sequential
 * (gentle on the subprocess budget); a per-task failure is logged, never
 * fatal, never blocks the other tasks in the pass.
 */

import { spawn } from "node:child_process"
import type { DaemonOrchestrator, DaemonTask as Task } from "./contracts.ts"
import { logDaemonError, logDaemonInfo } from "./crash-log.ts"
import type { DaemonRuntimeAdapter } from "./runtime.ts"

export interface GhPrView {
  readonly number?: number
  readonly state?: string
  readonly statusCheckRollup?: readonly unknown[]
  readonly [key: string]: unknown
}

export type PrViewErrorKind = "missing-binary" | "auth" | "timeout" | "network" | "parse" | "no-remote"

function classifyGhFailure(input: {
  spawnError?: boolean
  timedOut?: boolean
  stderr?: string
  parseError?: boolean
}): { kind: "empty" } | { kind: "error"; error: PrViewErrorKind } {
  if (input.parseError) return { kind: "error", error: "parse" }
  if (input.timedOut) return { kind: "error", error: "timeout" }
  if (input.spawnError) return { kind: "error", error: "missing-binary" }
  const stderr = (input.stderr ?? "").toLowerCase()
  if (["none of the git remotes", "no git remote", "not a github repository"].some((part) => stderr.includes(part)))
    return { kind: "error", error: "no-remote" }
  if (
    ["gh auth login", "authentication required", "not logged in", "bad credentials"].some((part) =>
      stderr.includes(part),
    )
  )
    return { kind: "error", error: "auth" }
  if (
    ["could not resolve host", "connection refused", "network is unreachable", "tls handshake", "rate limit"].some(
      (part) => stderr.includes(part),
    )
  )
    return { kind: "error", error: "network" }
  return { kind: "empty" }
}

/** Default re-scan cadence. PR checks move on the order of seconds-to-minutes;
 * 30s is responsive without hammering `gh` (which hits the network). */
export const DEFAULT_PR_STATUS_POLL_MS = 30_000
/** Re-poll backoff for a branch with no PR yet. */
export const NO_PR_BACKOFF_MS = 5 * 60_000
/** Re-poll backoff once a PR is merged/closed — effectively done. */
export const SETTLED_BACKOFF_MS = 10 * 60_000
/** First transient-failure backoff (doubles per consecutive failure). */
export const PR_FAILURE_BASE_MS = DEFAULT_PR_STATUS_POLL_MS
/** Cap on the exponential failure backoff — a persistently broken `gh`
 * (missing/unauthed) settles here instead of spawning every tick. */
export const PR_FAILURE_CAP_MS = 15 * 60_000
/** Deterministic "no GitHub remote" idle cadence — this repo will never have a
 * GitHub PR, so re-checking it more than rarely is pure waste. */
export const NO_REMOTE_BACKOFF_MS = 30 * 60_000
/** ± jitter ratio on every scheduled delay (de-syncs N tasks after a reconnect). */
export const PR_POLL_JITTER_RATIO = 0.2
/** Kill a `gh pr view` that hangs past this (network stall). */
export const PR_VIEW_TIMEOUT_MS = 10_000

/**
 * The outcome of one `gh pr view`:
 *   - `pr`    — a parsed payload (the only case that WRITES a status).
 *   - `empty` — gh ran and there is genuinely no PR for the branch.
 *   - `error` — a `gh`/transport failure (typed by {@link PrViewErrorKind}):
 *               gh missing/unauthed, a timeout, a network blip, bad JSON, or no
 *               GitHub remote. Distinguishing this from `empty` is the whole
 *               point — an error keeps the last status + logs *why* it's stale,
 *               instead of masquerading as "no PR".
 */
export type PrViewResult =
  | { kind: "pr"; view: GhPrView }
  | { kind: "empty" }
  | { kind: "error"; error: PrViewErrorKind }

/** Runs `gh pr view` for a branch in a worktree. Injectable for tests. */
export type PrViewRunner = (worktreePath: string, branch: string) => Promise<PrViewResult>

interface GhSpawnResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** The child failed to spawn (ENOENT etc.) and it was NOT our abort. */
  readonly spawnError: boolean
}

/** Spawn `gh` capturing stdout AND stderr (needed to classify the failure).
 * Never rejects: a spawn error or abort resolves with `status: null` so the
 * caller branches on the captured signals rather than a thrown error. */
function spawnGh(args: readonly string[], cwd: string, signal: AbortSignal): Promise<GhSpawnResult> {
  return new Promise((resolve) => {
    let out = ""
    let err = ""
    let settled = false
    const finish = (status: number | null, spawnError: boolean): void => {
      if (settled) return
      settled = true
      resolve({ status, stdout: out, stderr: err, spawnError })
    }
    const child = spawn("gh", args.slice(), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
      killSignal: "SIGKILL",
    })
    child.stdout?.on("data", (chunk: Buffer | string) => {
      out += String(chunk)
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      err += String(chunk)
    })
    // An abort (our timeout) also surfaces as an `error` event — don't count
    // that as a spawn failure; the caller reads `timedOut` separately.
    child.on("error", () => finish(null, !signal.aborted))
    child.on("close", (code) => finish(code, false))
  })
}

/** The real runner. Exit 0 with parseable JSON carrying a PR number → `pr`;
 * exit 0 + no number, or a recognized "no PR" stderr → `empty`; everything
 * else (gh missing/unauthed, timeout, network, bad JSON, no remote) → a typed
 * `error`. Never throws. */
export const runGhPrView: PrViewRunner = async (worktreePath, branch) => {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, PR_VIEW_TIMEOUT_MS)
  try {
    const res = await spawnGh(
      [
        "pr",
        "view",
        branch,
        "--json",
        "number,url,title,state,baseRefName,headRefName,reviewDecision,mergeable,statusCheckRollup",
      ],
      worktreePath,
      controller.signal,
    )
    if (res.status === 0 && !timedOut) {
      try {
        const view = JSON.parse(res.stdout) as GhPrView
        return typeof view.number === "number" ? { kind: "pr", view } : { kind: "empty" }
      } catch {
        return classifyGhFailure({ parseError: true })
      }
    }
    return classifyGhFailure({ spawnError: res.spawnError, timedOut, stderr: res.stderr })
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
  if (task.repo.startsWith("ssh://") || task.worktreePath.startsWith("ssh://")) return false
  return true
}

/** Per-task scheduling state: next-allowed-at + the consecutive-failure streak
 * that drives exponential backoff. Reset to `failures: 0` on any success / empty
 * / no-remote. */
export interface PrPollEntry {
  readonly nextAllowedAt: number
  readonly failures: number
}

/** Per-task schedule, keyed by task id. Carried across passes by the live poller. */
export type PrPollSchedule = Map<string, PrPollEntry>

export interface PrStatusPassOptions {
  readonly runtime: Pick<DaemonRuntimeAdapter, "prStatus">
  readonly run: PrViewRunner
  /** `Date.now()`-style clock (ms). Injected so tests are deterministic. */
  readonly now: number
  /** ISO timestamp stamped onto each status. Injected for the same reason. */
  readonly at: string
  /** Per-task backoff state, carried across passes by the live poller. */
  readonly schedule: PrPollSchedule
  readonly tickMs?: number
  /** `Math.random`-style source for jitter. Injected so tests are deterministic
   * (`() => 0.5` cancels the jitter to the exact base delay). */
  readonly rand?: () => number
}

/**
 * Run one polling pass over every eligible task whose backoff has elapsed.
 * Returns the ids whose persisted status actually changed (for tests). Pure
 * orchestrator work — no timers, no `Date.now()`.
 */
export async function runPrStatusPass(orch: DaemonOrchestrator, opts: PrStatusPassOptions): Promise<string[]> {
  const tickMs = opts.tickMs ?? DEFAULT_PR_STATUS_POLL_MS
  const rand = opts.rand
  const cfg = {
    tickMs,
    settledMs: SETTLED_BACKOFF_MS,
    noPrMs: NO_PR_BACKOFF_MS,
    noRemoteMs: NO_REMOTE_BACKOFF_MS,
    failureBaseMs: PR_FAILURE_BASE_MS,
    failureCapMs: PR_FAILURE_CAP_MS,
    jitterRatio: PR_POLL_JITTER_RATIO,
  }
  const changed: string[] = []
  for (const task of orch.listTasks()) {
    if (!isPrPollable(task)) {
      opts.schedule.delete(task.id) // forget backoff for now-ineligible tasks
      continue
    }
    const entry = opts.schedule.get(task.id)
    if (entry && opts.now < entry.nextAllowedAt) continue
    const prevFailures = entry?.failures ?? 0
    try {
      const result = await opts.run(task.worktreePath, task.branch)
      if (result.kind === "error") {
        // A real gh/transport failure — NOT "no PR". Keep the last value (don't
        // clobber a good chip with a transient blip), log why it's stale so it's
        // diagnosable, and back off (exponential for transients; a long idle
        // cadence for the deterministic no-remote case).
        logDaemonInfo(
          "pr-status-poller",
          `gh pr view failed (${result.error}) for task ${task.id} [${task.branch}] — keeping last PR status, backing off`,
        )
        opts.schedule.set(
          task.id,
          opts.runtime.prStatus.nextPoll({ kind: "error", error: result.error }, prevFailures, opts.now, cfg, rand),
        )
        continue
      }
      if (result.kind === "empty") {
        // gh ran and there is genuinely no PR yet. Keep the last value; back off
        // (a branch rarely sprouts a PR between ticks).
        opts.schedule.set(task.id, opts.runtime.prStatus.nextPoll({ kind: "empty" }, prevFailures, opts.now, cfg, rand))
        continue
      }
      const next = opts.runtime.prStatus.mapView(result.view, opts.at)
      // Re-read under the live store (the task may have been archived/deleted
      // during the await) and diff before writing.
      const current = orch.getTask(task.id)
      if (!current) {
        opts.schedule.delete(task.id)
        continue
      }
      if (!opts.runtime.prStatus.sameStatus(current.prStatus, next ?? undefined)) {
        await orch.setPRStatus(task.id, next)
        changed.push(task.id)
      }
      // A merged/closed PR is done — poll it rarely; an open one tracks checks.
      const settled = next?.lifecycle === "merged" || next?.lifecycle === "closed"
      opts.schedule.set(
        task.id,
        opts.runtime.prStatus.nextPoll({ kind: "pr", settled }, prevFailures, opts.now, cfg, rand),
      )
    } catch (err) {
      // The injected runner threw (the real one never does). Treat as a
      // transient error so it backs off rather than hammering.
      logDaemonError("pr-status-poller", err)
      opts.schedule.set(
        task.id,
        opts.runtime.prStatus.nextPoll({ kind: "error", error: "network" }, prevFailures, opts.now, cfg, rand),
      )
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
  orch: DaemonOrchestrator,
  runtime: Pick<DaemonRuntimeAdapter, "prStatus">,
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
    void runPrStatusPass(orch, {
      runtime,
      run,
      now: Date.now(),
      at: new Date().toISOString(),
      schedule,
      tickMs: intervalMs,
    })
      .catch((err) => logDaemonError("pr-status-poller", err))
      .finally(() => {
        running = false
      })
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
