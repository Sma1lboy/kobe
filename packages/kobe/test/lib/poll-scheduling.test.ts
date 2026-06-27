/**
 * Shared poll-scheduling core (`src/lib/poll-scheduling.ts`) — extracted
 * from the TUI's background-poll so the daemon's worktree-changes
 * collector reuses the EXACT guards behind the 30GB-repo-freeze fix.
 * The pure cadence math (computeNextAllowedAt / shouldPoll) keeps its
 * original coverage via the worktree-changes-poller tests (re-exported
 * API); this file pins the run wrapper the two bindings share:
 * in-flight dedupe, the timeout → hard-backoff path, and the
 * "failures never deliver a value" contract.
 */

import { describe, expect, test } from "vitest"
import { applyJitter, exponentialBackoff, maybeStartScheduledRun } from "../../src/lib/poll-scheduling.ts"

const CFG = { timeoutMs: 30, slowRetryMs: 60_000, minIntervalMs: 0 }

async function settle(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe("maybeStartScheduledRun", () => {
  test("delivers a successful value and re-opens the schedule", async () => {
    const state = { inFlight: false, nextAllowedAt: 0 }
    const values: number[] = []
    expect(
      maybeStartScheduledRun(
        state,
        CFG,
        async () => 42,
        (v) => values.push(v),
      ),
    ).toBe(true)
    expect(state.inFlight).toBe(true)
    await settle()
    expect(values).toEqual([42])
    expect(state.inFlight).toBe(false)
    expect(state.nextAllowedAt).toBeGreaterThan(0)
  })

  test("dedupes while in flight — the second call starts nothing", async () => {
    const state = { inFlight: false, nextAllowedAt: 0 }
    let release: ((v: number) => void) | undefined
    let starts = 0
    const run = (): Promise<number> => {
      starts++
      return new Promise((r) => {
        release = r
      })
    }
    expect(maybeStartScheduledRun(state, CFG, run, () => {})).toBe(true)
    expect(maybeStartScheduledRun(state, CFG, run, () => {})).toBe(false)
    expect(starts).toBe(1)
    release?.(1)
    await settle()
  })

  test("respects the backoff window", () => {
    const state = { inFlight: false, nextAllowedAt: Date.now() + 60_000 }
    expect(
      maybeStartScheduledRun(
        state,
        CFG,
        async () => 1,
        () => {},
      ),
    ).toBe(false)
  })

  test("timeout aborts the run, drops the value, and backs off hard", async () => {
    const state = { inFlight: false, nextAllowedAt: 0 }
    const before = Date.now()
    const values: number[] = []
    // A run that only settles when its AbortSignal fires — the spawnCapture
    // contract (the child is SIGKILLed and the promise resolves on close).
    maybeStartScheduledRun(
      state,
      CFG,
      (signal) => new Promise<number>((r) => signal.addEventListener("abort", () => r(99))),
      (v) => values.push(v),
    )
    await settle(CFG.timeoutMs + 20)
    expect(values).toEqual([]) // a timed-out value is never delivered
    expect(state.inFlight).toBe(false)
    // Hard backoff from the START time, not the adaptive cadence.
    expect(state.nextAllowedAt).toBeGreaterThanOrEqual(before + CFG.slowRetryMs)
  })

  test("a throwing run delivers nothing but re-opens the schedule", async () => {
    const state = { inFlight: false, nextAllowedAt: 0 }
    const values: number[] = []
    maybeStartScheduledRun(
      state,
      CFG,
      async () => {
        throw new Error("git status failed")
      },
      (v) => values.push(v),
    )
    await settle()
    expect(values).toEqual([])
    expect(state.inFlight).toBe(false)
  })
})

describe("applyJitter", () => {
  test("rand 0.5 is the no-jitter midpoint (exact delay)", () => {
    expect(applyJitter(1000, 0.2, () => 0.5)).toBe(1000)
  })
  test("rand 0 / 1 hit the ± bounds of the ratio band", () => {
    expect(applyJitter(1000, 0.2, () => 0)).toBe(800) // -20%
    expect(applyJitter(1000, 0.2, () => 1)).toBe(1200) // +20%
  })
  test("stays within [delay·(1−r), delay·(1+r)] across the rand range", () => {
    for (const r of [0, 0.13, 0.5, 0.87, 1]) {
      const v = applyJitter(1000, 0.25, () => r)
      expect(v).toBeGreaterThanOrEqual(750)
      expect(v).toBeLessThanOrEqual(1250)
    }
  })
  test("ratio is clamped to [0,1] and the result is never negative", () => {
    expect(applyJitter(1000, 0, () => 0)).toBe(1000) // no jitter
    expect(applyJitter(1000, 5, () => 0)).toBe(0) // clamp to ratio 1 → max(0, -1000) extreme
  })
})

describe("exponentialBackoff", () => {
  test("doubles per attempt from the base", () => {
    expect(exponentialBackoff(1000, 0, 60_000)).toBe(1000)
    expect(exponentialBackoff(1000, 1, 60_000)).toBe(2000)
    expect(exponentialBackoff(1000, 3, 60_000)).toBe(8000)
  })
  test("caps at capMs and clamps negative attempts to the base", () => {
    expect(exponentialBackoff(1000, 10, 5000)).toBe(5000)
    expect(exponentialBackoff(1000, -1, 60_000)).toBe(1000)
  })
})
