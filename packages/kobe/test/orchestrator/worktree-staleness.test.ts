import { describe, expect, it } from "vitest"
import {
  STALE_AGE_DAYS,
  type WorktreeStaleSignals,
  judgeWorktree,
  parseGhPrList,
} from "../../src/orchestrator/worktree/staleness.ts"

/**
 * The staleness rubric drives the worktrees page's "safe to clean?"
 * badges. The cascade ORDER is the contract: strong signals (dirty, PR
 * state) must always beat weak fallbacks (ahead-count, age) — kobe's
 * default squash-merge makes the PR-merged signal the only one that can
 * identify a merged branch, and a dirty tree must never be called stale
 * no matter how old or how merged its branch looks.
 */

const NOW = 1_750_000_000_000
const DAY = 24 * 60 * 60 * 1000

function signals(overrides: Partial<WorktreeStaleSignals>): WorktreeStaleSignals {
  return { dirty: false, prState: null, aheadOfDefault: null, lastActivityMs: NOW - DAY, ...overrides }
}

describe("judgeWorktree cascade", () => {
  it("dirty beats everything — even a merged PR on an ancient branch", () => {
    const j = judgeWorktree(
      signals({ dirty: true, prState: "merged", aheadOfDefault: 0, lastActivityMs: NOW - 100 * DAY }),
      NOW,
    )
    expect(j).toEqual({ verdict: "active", reason: "dirty" })
  })

  it("an open PR keeps an old clean branch active", () => {
    const j = judgeWorktree(signals({ prState: "open", lastActivityMs: NOW - 100 * DAY }), NOW)
    expect(j).toEqual({ verdict: "active", reason: "prOpen" })
  })

  it("a merged PR marks the branch merged even when squash left it ahead of main", () => {
    // Squash-merge: branch commits never become ancestors, ahead stays > 0.
    const j = judgeWorktree(signals({ prState: "merged", aheadOfDefault: 3 }), NOW)
    expect(j).toEqual({ verdict: "merged", reason: "prMerged" })
  })

  it("0 commits ahead of the default branch reads as merged without any PR data", () => {
    const j = judgeWorktree(signals({ prState: null, aheadOfDefault: 0 }), NOW)
    expect(j).toEqual({ verdict: "merged", reason: "inMain" })
  })

  it("a closed-unmerged PR with unique commits is stale (abandoned)", () => {
    const j = judgeWorktree(signals({ prState: "closed", aheadOfDefault: 2 }), NOW)
    expect(j).toEqual({ verdict: "stale", reason: "prClosed" })
  })

  it("age is the last fallback: idle past the threshold is stale, inside it is fresh", () => {
    const old = signals({ lastActivityMs: NOW - (STALE_AGE_DAYS + 1) * DAY, aheadOfDefault: 2 })
    expect(judgeWorktree(old, NOW)).toEqual({ verdict: "stale", reason: "idle" })
    const recent = signals({ lastActivityMs: NOW - (STALE_AGE_DAYS - 1) * DAY, aheadOfDefault: 2 })
    expect(judgeWorktree(recent, NOW)).toEqual({ verdict: "fresh", reason: "fresh" })
  })

  it("unknown activity time (0) never triggers the age fallback", () => {
    expect(judgeWorktree(signals({ lastActivityMs: 0, aheadOfDefault: 1 }), NOW)).toEqual({
      verdict: "fresh",
      reason: "fresh",
    })
  })
})

describe("parseGhPrList", () => {
  it("maps branches to PR states, strongest state winning per branch", () => {
    const map = parseGhPrList(
      JSON.stringify([
        { headRefName: "feat/a", state: "CLOSED" },
        { headRefName: "feat/a", state: "OPEN" }, // reopened — open must win
        { headRefName: "fix/b", state: "MERGED" },
        { headRefName: "fix/b", state: "CLOSED" }, // stray closed duplicate loses
      ]),
    )
    expect(map?.get("feat/a")).toBe("open")
    expect(map?.get("fix/b")).toBe("merged")
  })

  it("returns null on malformed output and skips malformed entries", () => {
    expect(parseGhPrList("gh: command not found")).toBeNull()
    expect(parseGhPrList('{"not":"an array"}')).toBeNull()
    const map = parseGhPrList(
      JSON.stringify([
        { headRefName: 1, state: "OPEN" },
        { headRefName: "ok", state: "MERGED" },
      ]),
    )
    expect(map?.size).toBe(1)
    expect(map?.get("ok")).toBe("merged")
  })
})
