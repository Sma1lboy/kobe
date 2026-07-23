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
 * The guards themselves (the pure scheduling math + the abort/timeout run
 * wrapper + `spawnCapture`) live in the dependency-free
 * `src/lib/poll-scheduling.ts`, shared with the DAEMON's worktree-changes
 * collector (issue #6) — this module holds a per-key value cell that `poll`
 * writes and `read` returns. Callers (the React panes) read imperatively on
 * their own render cadence; the re-exports below keep this module's public
 * API exactly what it was before the extraction.
 *
 * Failure contract: a run that throws, is aborted, or resolves after the
 * timeout never writes — `read` keeps returning the last good value (or
 * `initial`), so the UI goes stale or stays hidden rather than erroring.
 */

import { type PollScheduleState, maybeStartScheduledRun } from "../../lib/poll-scheduling.ts"

export {
  computeNextAllowedAt,
  decodeCapturedChunks,
  shouldPoll,
  spawnCapture,
  type SpawnCaptureResult,
} from "../../lib/poll-scheduling.ts"

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
   * Value equality for the cell — a run returning an equal value is not
   * written back. Defaults to `===`.
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

interface PollEntry<T> extends PollScheduleState {
  read: () => T
  write: (next: T) => void
}

export function createBackgroundPoller<T>(cfg: BackgroundPollerConfig<T>): BackgroundPoller<T> {
  // DELIBERATELY no eviction (memory-audit decision, 2026-06): the map
  // gains one entry (~a value cell + key string + a small T) per distinct
  // key ever read/polled and never drops it, so a long-lived pane process
  // retains entries for deleted tasks' worktrees. That growth is bounded by
  // "distinct worktree paths this process ever rendered" — hundreds of
  // entries ≈ tens of KB. `reset()` (tests) is the only teardown.
  const entries = new Map<string, PollEntry<T>>()
  const equals = cfg.equals ?? ((a, b) => a === b)

  function entryFor(key: string): PollEntry<T> {
    let entry = entries.get(key)
    if (!entry) {
      let current = cfg.initial
      entry = {
        read: () => current,
        write: (next) => {
          if (!equals(current, next)) current = next
        },
        inFlight: false,
        nextAllowedAt: 0,
      }
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
      maybeStartScheduledRun(
        entry,
        cfg,
        (signal) => cfg.run(key, signal),
        (value) => entry.write(value),
      )
    },
    reset(): void {
      entries.clear()
    },
  }
}
