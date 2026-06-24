import { describe, expect, test } from "vitest"
import {
  type GhPrView,
  checkResolutionNotify,
  checkStateFromRollup,
  lifecycleFromState,
  mapGhPrView,
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
