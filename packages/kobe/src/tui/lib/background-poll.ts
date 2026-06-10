/**
 * Generic background poller for render paths that need subprocess-derived
 * data (git status, git HEAD, …) without ever blocking the event loop.
 *
 * Extracted from the sidebar's worktree-changes poller — the fix for the
 * 30GB-repo freeze, where a synchronous per-row `git status` on the ~2s
 * tick blocked the render thread for the whole O(repo size) status walk.
 * The rule (see docs/DESIGN.md §5.4 and the guard test
 * `test/tui/render-path-sync-guard.test.ts`): render processes must not
 * run synchronous subprocesses. A pane that wants live subprocess data
 * creates one of these pollers and calls `poll(key)` from its memo —
 * fire-and-forget — while `read(key)` stays a cheap reactive signal read.
 *
 * One poller instance owns a module-level entry map: per key (a repo /
 * worktree path), a Solid signal holding the last good value plus
 * scheduling state. Three guards keep the child-process budget sane:
 *
 *   - **in-flight dedupe** — one run per key at a time; ticks that land
 *     while a run is still going are dropped.
 *   - **adaptive cadence** — the next run is allowed only after
 *     `max(minIntervalMs, 5 × last duration)`: fast repos keep the tick
 *     cadence, slow-but-finishing repos thin out on their own.
 *   - **timeout + backoff** — a run exceeding `timeoutMs` is aborted
 *     (children spawned via `spawnCapture` get SIGKILLed) and the key
 *     backs off for `slowRetryMs`.
 *
 * Failure contract: a run that throws, is aborted, or resolves after the
 * timeout never writes — `read` keeps returning the last good value (or
 * `initial`), so the UI goes stale or stays hidden rather than erroring.
 */

import { spawn } from "node:child_process"
import { createSignal } from "solid-js"

export interface BackgroundPollerConfig<T> {
  /**
   * Produce a fresh value for `key`. Runs in the background; receives an
   * AbortSignal that fires at `timeoutMs` — pass it to `spawnCapture` so
   * a runaway child is SIGKILLed. Throw to keep the last value.
   */
  readonly run: (key: string, signal: AbortSignal) => Promise<T>
  /** Abort a run (and back off) after this long. */
  readonly timeoutMs: number
  /** After a timeout, leave the key alone for this long before retrying. */
  readonly slowRetryMs: number
  /** Floor between successful runs — typically the caller's tick cadence. */
  readonly minIntervalMs: number
  /**
   * Value equality for the signal — a run returning an equal value does
   * not re-render readers. Defaults to Solid's `===`.
   */
  readonly equals?: (a: T, b: T) => boolean
  /** Value returned by `read` before the first run lands (and for empty keys). */
  readonly initial: T
}

export interface BackgroundPoller<T> {
  /** Reactive read of the last known value for `key`. Never blocks. */
  read(key: string): T
  /**
   * Fire-and-forget: maybe start a background run for `key`. Safe to call
   * from a reactive memo on every tick — the guards make extra calls free,
   * and a signal update caused by a finishing run cannot re-trigger an
   * immediate spawn (`minIntervalMs` floor).
   */
  poll(key: string): void
  /** Drop all cached entries/backoff state (test hook). */
  reset(): void
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

interface PollEntry<T> {
  read: () => T
  write: (next: T) => void
  inFlight: boolean
  nextAllowedAt: number
}

export function createBackgroundPoller<T>(cfg: BackgroundPollerConfig<T>): BackgroundPoller<T> {
  const entries = new Map<string, PollEntry<T>>()

  function entryFor(key: string): PollEntry<T> {
    let entry = entries.get(key)
    if (!entry) {
      const [read, set] = createSignal<T>(cfg.initial, cfg.equals ? { equals: cfg.equals } : undefined)
      entry = { read, write: (next) => set(() => next), inFlight: false, nextAllowedAt: 0 }
      entries.set(key, entry)
    }
    return entry
  }

  return {
    read(key: string): T {
      if (!key) return cfg.initial
      return entryFor(key).read()
    },
    poll(key: string): void {
      if (!key) return
      const entry = entryFor(key)
      const startedAt = Date.now()
      if (!shouldPoll(entry, startedAt)) return
      entry.inFlight = true
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
      void (async () => {
        let value: T | undefined
        let ok = false
        try {
          value = await cfg.run(key, controller.signal)
          ok = true
        } catch {
          // Keep the last value — the reader goes stale, never errors.
        }
        clearTimeout(timer)
        const timedOut = controller.signal.aborted
        entry.nextAllowedAt = computeNextAllowedAt(startedAt, Date.now(), timedOut, cfg)
        entry.inFlight = false
        if (ok && !timedOut) entry.write(value as T)
      })()
    },
    reset(): void {
      entries.clear()
    },
  }
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
