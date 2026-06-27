import { describe, expect, test } from "vitest"
import {
  type GhPrView,
  type PrBackoffConfig,
  checkResolutionNotify,
  checkStateFromRollup,
  classifyGhFailure,
  lifecycleFromState,
  mapGhPrView,
  nextPrPoll,
  samePrStatus,
} from "../../src/monitor/pr-status"

describe("lifecycleFromState", () => {
  test("maps gh PR state to lifecycle", () => {
    expect(lifecycleFromState("MERGED", undefined)).toBe("merged")
    expect(lifecycleFromState("CLOSED", undefined)).toBe("closed")
    expect(lifecycleFromState("OPEN", undefined)).toBe("open")
    expect(lifecycleFromState("open", "REVIEW_REQUIRED")).toBe("open")
    expect(lifecycleFromState("garbage", undefined)).toBe("unknown")
  })
  test("an approved open PR is ready_to_merge", () => {
    expect(lifecycleFromState("OPEN", "APPROVED")).toBe("ready_to_merge")
  })
})

describe("checkStateFromRollup", () => {
  test("no rollup / empty → none (no checks configured)", () => {
    expect(checkStateFromRollup(undefined)).toBe("none")
    expect(checkStateFromRollup([])).toBe("none")
  })
  test("any failing CheckRun → failing, regardless of others", () => {
    expect(
      checkStateFromRollup([
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
      ]),
    ).toBe("failing")
  })
  test("in-progress with no failure → pending", () => {
    expect(
      checkStateFromRollup([
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", status: "IN_PROGRESS" },
      ]),
    ).toBe("pending")
  })
  test("all success/neutral/skipped → passing", () => {
    expect(
      checkStateFromRollup([
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "NEUTRAL" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
      ]),
    ).toBe("passing")
  })
  test("legacy StatusContext entries are read via state", () => {
    expect(checkStateFromRollup([{ __typename: "StatusContext", state: "SUCCESS" }])).toBe("passing")
    expect(checkStateFromRollup([{ __typename: "StatusContext", state: "PENDING" }])).toBe("pending")
    expect(checkStateFromRollup([{ __typename: "StatusContext", state: "FAILURE" }])).toBe("failing")
  })
  test("failure precedence beats a pending sibling", () => {
    expect(checkStateFromRollup([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }])).toBe(
      "failing",
    )
  })
})

describe("mapGhPrView", () => {
  const at = "2026-06-24T00:00:00.000Z"
  test("no PR number → null (no PR for the branch)", () => {
    expect(mapGhPrView(null, at)).toBeNull()
    expect(mapGhPrView({}, at)).toBeNull()
  })
  test("maps a full open PR with running checks", () => {
    const view: GhPrView = {
      number: 42,
      url: "https://github.com/o/r/pull/42",
      title: "feat: x",
      state: "OPEN",
      baseRefName: "main",
      headRefName: "feat/x",
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ status: "IN_PROGRESS" }],
    }
    expect(mapGhPrView(view, at)).toEqual({
      provider: "github",
      lifecycle: "open",
      checkState: "pending",
      number: 42,
      url: "https://github.com/o/r/pull/42",
      title: "feat: x",
      baseRef: "main",
      headRef: "feat/x",
      reviewDecision: "REVIEW_REQUIRED",
      mergeable: "MERGEABLE",
      lastCheckedAt: at,
    })
  })
  test("empty-string reviewDecision/mergeable normalize to undefined", () => {
    const out = mapGhPrView({ number: 1, state: "OPEN", reviewDecision: "", mergeable: "" }, at)
    expect(out?.reviewDecision).toBeUndefined()
    expect(out?.mergeable).toBeUndefined()
  })
})

describe("samePrStatus", () => {
  const base = mapGhPrView({ number: 1, state: "OPEN", statusCheckRollup: [{ status: "IN_PROGRESS" }] }, "t1")
  test("ignores lastCheckedAt churn", () => {
    const later = mapGhPrView({ number: 1, state: "OPEN", statusCheckRollup: [{ status: "IN_PROGRESS" }] }, "t2")
    expect(samePrStatus(base ?? undefined, later ?? undefined)).toBe(true)
  })
  test("a checkState change is not equal", () => {
    const passed = mapGhPrView(
      { number: 1, state: "OPEN", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] },
      "t3",
    )
    expect(samePrStatus(base ?? undefined, passed ?? undefined)).toBe(false)
  })
  test("undefined handling", () => {
    expect(samePrStatus(undefined, undefined)).toBe(true)
    expect(samePrStatus(base ?? undefined, undefined)).toBe(false)
  })
})

describe("classifyGhFailure", () => {
  test("parse error / timeout / missing-binary take priority over stderr", () => {
    expect(classifyGhFailure({ parseError: true })).toEqual({ kind: "error", error: "parse" })
    expect(classifyGhFailure({ timedOut: true, stderr: "anything" })).toEqual({ kind: "error", error: "timeout" })
    expect(classifyGhFailure({ spawnError: true })).toEqual({ kind: "error", error: "missing-binary" })
  })
  test("a recognized 'no PR' stderr is a genuine empty, NOT an error", () => {
    expect(classifyGhFailure({ exitCode: 1, stderr: 'no pull requests found for branch "x"' })).toEqual({
      kind: "empty",
    })
  })
  test("no-remote / auth / network stderr map to their kinds", () => {
    expect(classifyGhFailure({ exitCode: 1, stderr: "none of the git remotes point to a GitHub host" })).toEqual({
      kind: "error",
      error: "no-remote",
    })
    expect(
      classifyGhFailure({ exitCode: 1, stderr: "To get started with GitHub CLI, please run: gh auth login" }),
    ).toEqual({ kind: "error", error: "auth" })
    expect(classifyGhFailure({ exitCode: 1, stderr: "dial tcp: could not resolve host: api.github.com" })).toEqual({
      kind: "error",
      error: "network",
    })
  })
  test("an unrecognized non-zero exit defaults to empty (gh's dominant no-PR case)", () => {
    expect(classifyGhFailure({ exitCode: 1, stderr: "some unfamiliar message" })).toEqual({ kind: "empty" })
  })
})

describe("nextPrPoll", () => {
  // rand 0.5 cancels the jitter so the delays are exact + assertable.
  const noJitter = (): number => 0.5
  const cfg: PrBackoffConfig = {
    tickMs: 30_000,
    settledMs: 600_000,
    noPrMs: 300_000,
    noRemoteMs: 1_800_000,
    failureBaseMs: 30_000,
    failureCapMs: 900_000,
    jitterRatio: 0.2,
  }

  test("success resets the failure streak and uses the tick (or settled) cadence", () => {
    expect(nextPrPoll({ kind: "pr", settled: false }, 4, 1000, cfg, noJitter)).toEqual({
      nextAllowedAt: 1000 + 30_000,
      failures: 0,
    })
    expect(nextPrPoll({ kind: "pr", settled: true }, 4, 1000, cfg, noJitter)).toEqual({
      nextAllowedAt: 1000 + 600_000,
      failures: 0,
    })
  })

  test("a genuine empty resets the streak and uses the no-PR backoff", () => {
    expect(nextPrPoll({ kind: "empty" }, 3, 0, cfg, noJitter)).toEqual({ nextAllowedAt: 300_000, failures: 0 })
  })

  test("transient errors grow exponentially and cap", () => {
    expect(nextPrPoll({ kind: "error", error: "auth" }, 0, 0, cfg, noJitter)).toEqual({
      nextAllowedAt: 30_000,
      failures: 1,
    })
    expect(nextPrPoll({ kind: "error", error: "network" }, 1, 0, cfg, noJitter)).toEqual({
      nextAllowedAt: 60_000,
      failures: 2,
    })
    expect(nextPrPoll({ kind: "error", error: "missing-binary" }, 4, 0, cfg, noJitter)).toEqual({
      nextAllowedAt: 480_000, // 30s · 2^4
      failures: 5,
    })
    // Deep into the streak the backoff is clamped to the cap.
    expect(nextPrPoll({ kind: "error", error: "missing-binary" }, 20, 0, cfg, noJitter).nextAllowedAt).toBe(900_000)
  })

  test("a success after failures returns to the normal cadence (streak reset)", () => {
    const after = nextPrPoll({ kind: "pr", settled: false }, 6, 0, cfg, noJitter)
    expect(after).toEqual({ nextAllowedAt: 30_000, failures: 0 })
  })

  test("no-remote is deterministic: settles to the long idle cadence, no streak", () => {
    expect(nextPrPoll({ kind: "error", error: "no-remote" }, 9, 0, cfg, noJitter)).toEqual({
      nextAllowedAt: 1_800_000,
      failures: 0,
    })
  })

  test("jitter keeps the delay inside the ± ratio band", () => {
    for (const r of [0, 0.25, 0.75, 1]) {
      const at = nextPrPoll({ kind: "pr", settled: false }, 0, 0, cfg, () => r).nextAllowedAt
      expect(at).toBeGreaterThanOrEqual(30_000 * 0.8)
      expect(at).toBeLessThanOrEqual(30_000 * 1.2)
    }
  })
})

describe("checkResolutionNotify", () => {
  test("notifies only when pending resolves", () => {
    expect(checkResolutionNotify("pending", "passing")).toBe("passing")
    expect(checkResolutionNotify("pending", "failing")).toBe("failing")
  })
  test("does not notify on CI starting or steady states", () => {
    expect(checkResolutionNotify("none", "pending")).toBeNull()
    expect(checkResolutionNotify(undefined, "passing")).toBeNull()
    expect(checkResolutionNotify("passing", "passing")).toBeNull()
    expect(checkResolutionNotify("pending", "pending")).toBeNull()
  })
})
