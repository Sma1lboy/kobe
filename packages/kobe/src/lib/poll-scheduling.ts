/**
 * Pure scheduling core for subprocess-backed background polling —
 * extracted from `src/tui/lib/background-poll.ts` (issue #6) so the
 * daemon's worktree-changes collector can reuse the EXACT guards that
 * fixed the 30GB-repo freeze without importing solid-js (the TUI poller's
 * signal layer) into daemon code.
 *
 * The three guards live here; the two bindings differ only in where a
 * finished value goes:
 *
 *   - **in-flight dedupe** — one run per key at a time
 *     ({@link shouldPoll}); ticks landing mid-run are dropped.
 *   - **adaptive cadence** — the next run is allowed only after
 *     `max(minIntervalMs, 5 × last duration)` ({@link computeNextAllowedAt}):
 *     fast repos keep the tick cadence, slow-but-finishing repos self-thin.
 *   - **timeout + hard backoff** — a run exceeding `timeoutMs` is aborted
 *     (children spawned via {@link spawnCapture} get SIGKILLed) and the key
 *     backs off for `slowRetryMs`.
 *
 * `src/tui/lib/background-poll.ts` re-exports everything here, so its
 * public API is unchanged; TUI code keeps importing from there.
 * Dependency-free apart from `node:child_process` — safe for the daemon,
 * vitest, and any render process.
 */

import { spawn } from "node:child_process"

/** The cadence knobs every scheduled-poll consumer must pin down. */
export interface PollCadenceConfig {
  /** Abort a run (and back off hard) after this long. */
  readonly timeoutMs: number
  /** After a timeout, leave the key alone for this long before retrying. */
  readonly slowRetryMs: number
  /** Floor between successful runs — typically the caller's tick cadence. */
  readonly minIntervalMs: number
}

/** Per-key scheduling state the guards read/write. */
export interface PollScheduleState {
  inFlight: boolean
  nextAllowedAt: number
}

/**
 * When the next run may start. Pure — exported for unit tests.
 * Timed-out runs back off hard; completed runs scale with their own
 * duration so slow repos self-thin without a special case.
 */
export function computeNextAllowedAt(
  startedAt: number,
  finishedAt: number,
  timedOut: boolean,
  cfg: { readonly slowRetryMs: number; readonly minIntervalMs: number },
): number {
  if (timedOut) return startedAt + cfg.slowRetryMs
  return finishedAt + Math.max(cfg.minIntervalMs, (finishedAt - startedAt) * 5)
}

/** Whether a run may start now. Pure — exported for unit tests. */
export function shouldPoll(state: { inFlight: boolean; nextAllowedAt: number }, now: number): boolean {
  return !state.inFlight && now >= state.nextAllowedAt
}

/**
 * Maybe start one guarded background run for a key's schedule state.
 * Returns `false` (no run) when the guards say no — in flight, or inside
 * the cadence/backoff window. Otherwise marks the state in-flight, runs
 * `run` with an AbortSignal that fires at `timeoutMs` (pass it to
 * {@link spawnCapture} so a runaway child is SIGKILLed), and on settle
 * updates `nextAllowedAt` + clears the in-flight flag.
 *
 * Failure contract (same as the TUI poller it was extracted from): a run
 * that throws, is aborted, or resolves after the timeout never calls
 * `onValue` — the consumer keeps its last good value, so UIs go stale or
 * stay hidden rather than erroring.
 */
export function maybeStartScheduledRun<T>(
  state: PollScheduleState,
  cfg: PollCadenceConfig,
  run: (signal: AbortSignal) => Promise<T>,
  onValue: (value: T) => void,
): boolean {
  const startedAt = Date.now()
  if (!shouldPoll(state, startedAt)) return false
  state.inFlight = true
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
  void (async () => {
    let value: T | undefined
    let ok = false
    try {
      value = await run(controller.signal)
      ok = true
    } catch {
      // Keep the last value — the consumer goes stale, never errors.
    }
    clearTimeout(timer)
    const timedOut = controller.signal.aborted
    state.nextAllowedAt = computeNextAllowedAt(startedAt, Date.now(), timedOut, cfg)
    state.inFlight = false
    if (ok && !timedOut) onValue(value as T)
  })()
  return true
}

export interface SpawnCaptureResult {
  /** Exit code, or null when the child errored / was killed (timeout). */
  readonly status: number | null
  readonly stdout: string
}

/**
 * Async spawn that collects stdout and resolves on close. Never rejects —
 * a spawn error (missing cwd, binary not on PATH) or an abort resolves
 * with `status: null` so callers branch on status, mirroring the
 * never-throw contract of the pane-side sync git helpers it replaces.
 * The AbortSignal kills the child with SIGKILL.
 */
export function spawnCapture(
  cmd: string,
  args: readonly string[],
  opts: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly signal: AbortSignal },
): Promise<SpawnCaptureResult> {
  return new Promise((resolve) => {
    let out = ""
    let settled = false
    const finish = (status: number | null): void => {
      if (settled) return
      settled = true
      resolve({ status, stdout: out })
    }
    const child = spawn(cmd, args.slice(), {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "ignore"],
      env: opts.env,
      signal: opts.signal,
      killSignal: "SIGKILL",
    })
    child.stdout?.on("data", (chunk: Buffer | string) => {
      out += String(chunk)
    })
    child.on("error", () => finish(null))
    child.on("close", (code) => finish(code))
  })
}
