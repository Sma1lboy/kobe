/**
 * The Ops pane's framework-free poll loops (`tui/ops/activity-monitor.ts`),
 * extracted from the Solid host so the React port (issue #15, G3) runs the
 * SAME loop bodies. Why these tests matter: the loops were previously
 * component-internal and untestable (host.tsx pulls @opentui render
 * assets); the extraction makes the badge-prime rule ("only post-mount
 * activity flags"), the teardown-race swallow, and the ChatTab done rule
 * ("new completion id + quiescent pane") directly checkable with fake IO
 * and fake timers — regressions here silently break the `● new` badge or
 * report "done" for a sibling window's turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startLocalBadgePoll, startTurnStatusPoll } from "../../src/tui/ops/activity-monitor.ts"
import { ACTIVITY_POLL_MIN_MS, TURN_STATUS_POLL_MS } from "../../src/tui/ops/activity-poll.ts"

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** Badge-state harness standing in for the host's primed/baseline/latest. */
function badgeHooks() {
  const state = { primed: false, baseline: [] as number[], latest: [] as number[] }
  return {
    state,
    hooks: {
      isPrimed: () => state.primed,
      prime: (mtime: number) => {
        state.primed = true
        state.baseline.push(mtime)
      },
      setLatest: (mtime: number) => {
        state.latest.push(mtime)
      },
    },
  }
}

describe("startLocalBadgePoll", () => {
  it("primes on the first read, then reports each subsequent mtime", async () => {
    const mtimes = [100, 100, 250]
    let reads = 0
    const { state, hooks } = badgeHooks()
    const stop = startLocalBadgePoll(
      {
        sessionAttached: async () => true,
        latestMtime: async () => mtimes[Math.min(reads++, mtimes.length - 1)] as number,
      },
      hooks,
    )
    await vi.advanceTimersByTimeAsync(0)
    // First read seeds the baseline — it must NOT count as new activity.
    expect(state.baseline).toEqual([100])
    expect(state.latest).toEqual([100])
    await vi.advanceTimersByTimeAsync(ACTIVITY_POLL_MIN_MS)
    await vi.advanceTimersByTimeAsync(ACTIVITY_POLL_MIN_MS)
    expect(state.baseline).toEqual([100])
    expect(state.latest).toEqual([100, 100, 250])
    stop()
  })

  it("skips the probe entirely while the session is detached", async () => {
    const latestMtime = vi.fn(async () => 1)
    const { state, hooks } = badgeHooks()
    const stop = startLocalBadgePoll({ sessionAttached: async () => false, latestMtime }, hooks)
    await vi.advanceTimersByTimeAsync(ACTIVITY_POLL_MIN_MS * 3)
    expect(latestMtime).not.toHaveBeenCalled()
    expect(state.latest).toEqual([])
    stop()
  })

  it("swallows probe failures (worktree deleted mid-poll) and keeps ticking", async () => {
    let reads = 0
    const { state, hooks } = badgeHooks()
    const stop = startLocalBadgePoll(
      {
        sessionAttached: async () => true,
        latestMtime: async () => {
          reads++
          if (reads === 1) throw new Error("ENOENT")
          return 42
        },
      },
      hooks,
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(state.latest).toEqual([])
    await vi.advanceTimersByTimeAsync(ACTIVITY_POLL_MIN_MS)
    expect(state.baseline).toEqual([42])
    expect(state.latest).toEqual([42])
    stop()
    // Disposed: no further reads regardless of elapsed time.
    const after = reads
    await vi.advanceTimersByTimeAsync(ACTIVITY_POLL_MIN_MS * 10)
    expect(reads).toBe(after)
  })
})

describe("startTurnStatusPoll", () => {
  function makeIo(pane: () => string) {
    const published: string[] = []
    return {
      published,
      io: {
        sessionAttached: async () => true,
        capturePane: async () => pane(),
        setTurnState: async (state: string) => {
          published.push(state)
        },
      },
    }
  }

  it("fallback mode: idle on prime, running on pane change, done after quiescence + NEW completion", async () => {
    let pane = "A"
    let completion: string | null = "c0"
    const latestCompletion = vi.fn(async () => (completion ? { id: completion } : null))
    const { published, io } = makeIo(() => pane)
    const stop = startTurnStatusPoll(
      {
        worktree: "/wt",
        detector: { supportsCompletionMarkers: () => true, latestCompletion },
        usingShared: () => false,
        sharedEntry: () => null,
      },
      io,
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(published).toEqual(["idle"])
    // The pane content changed → a turn is running.
    pane = "B"
    await vi.advanceTimersByTimeAsync(TURN_STATUS_POLL_MS)
    expect(published).toEqual(["idle", "running"])
    // A new completion id lands, pane goes quiescent: done only after the
    // stable-poll threshold, not on the first unchanged read.
    completion = "c1"
    await vi.advanceTimersByTimeAsync(TURN_STATUS_POLL_MS)
    expect(published).toEqual(["idle", "running"])
    await vi.advanceTimersByTimeAsync(TURN_STATUS_POLL_MS)
    expect(published).toEqual(["idle", "running", "done"])
    stop()
  })

  it("stays quiet when the pane never changed, even with a new completion id (sibling-window turn)", async () => {
    let completion = "c0"
    const { published, io } = makeIo(() => "A")
    const stop = startTurnStatusPoll(
      {
        worktree: "/wt",
        detector: { supportsCompletionMarkers: () => true, latestCompletion: async () => ({ id: completion }) },
        usingShared: () => false,
        sharedEntry: () => null,
      },
      io,
    )
    await vi.advanceTimersByTimeAsync(0)
    completion = "c1"
    await vi.advanceTimersByTimeAsync(TURN_STATUS_POLL_MS * 5)
    expect(published).toEqual(["idle"])
    stop()
  })

  it("shared mode: completion comes from the daemon push, never a local transcript read", async () => {
    let pane = "A"
    let entry = { mtimeMs: 1, completionId: "c0", completionAt: 0 }
    const latestCompletion = vi.fn(async () => ({ id: "local-never-used" }))
    const { published, io } = makeIo(() => pane)
    const stop = startTurnStatusPoll(
      {
        worktree: "/wt",
        detector: { supportsCompletionMarkers: () => true, latestCompletion },
        usingShared: () => true,
        sharedEntry: () => entry,
      },
      io,
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(published).toEqual(["idle"])
    pane = "B"
    await vi.advanceTimersByTimeAsync(TURN_STATUS_POLL_MS)
    expect(published).toEqual(["idle", "running"])
    entry = { mtimeMs: 2, completionId: "c1", completionAt: 1 }
    await vi.advanceTimersByTimeAsync(TURN_STATUS_POLL_MS)
    await vi.advanceTimersByTimeAsync(TURN_STATUS_POLL_MS)
    expect(published).toEqual(["idle", "running", "done"])
    expect(latestCompletion).not.toHaveBeenCalled()
    stop()
  })

  it("unknown-marker engines publish unknown and never done", async () => {
    let pane = "A"
    const { published, io } = makeIo(() => pane)
    const stop = startTurnStatusPoll(
      {
        worktree: "/wt",
        detector: { supportsCompletionMarkers: () => false, latestCompletion: async () => ({ id: "x" }) },
        usingShared: () => false,
        sharedEntry: () => null,
      },
      io,
    )
    await vi.advanceTimersByTimeAsync(0)
    pane = "B"
    await vi.advanceTimersByTimeAsync(TURN_STATUS_POLL_MS * 4)
    expect(published).toEqual(["unknown"])
    stop()
  })
})
