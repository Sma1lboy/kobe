import { describe, expect, it } from "vitest"
import {
  prTransition,
  prTransitionBody,
  prTransitions,
} from "../src/lib/pr-notify.ts"
import type { Task, TaskPRStatus } from "../src/lib/types.ts"

// Why this matters: these edges become desktop notifications. A wrong rule
// here is either a missed "CI went red while you were away" (the feature's
// whole point) or a notification blast on every page load / PR creation
// (which gets the feature turned off).

const pr = (over: Partial<TaskPRStatus>): TaskPRStatus => ({
  provider: "github",
  lifecycle: "open",
  checkState: "pending",
  number: 7,
  ...over,
})

function task(id: string, prStatus: TaskPRStatus | undefined): Task {
  return {
    id,
    title: `Task ${id}`,
    repo: "/repo",
    branch: `kobe/${id}`,
    worktreePath: `/wt/${id}`,
    kind: "task",
    status: "active",
    archived: false,
    pinned: false,
    prStatus,
    createdAt: "2026-06-12T00:00:00Z",
    updatedAt: "2026-06-12T00:00:00Z",
  }
}

describe("prTransition", () => {
  it("never fires when either side has no PR (creation is not a transition)", () => {
    expect(prTransition(undefined, pr({}))).toBeNull()
    expect(prTransition(pr({}), undefined)).toBeNull()
    expect(prTransition(undefined, undefined)).toBeNull()
  })

  it("fires merged on the rising edge only", () => {
    expect(prTransition(pr({}), pr({ lifecycle: "merged" }))).toBe("merged")
    expect(
      prTransition(pr({ lifecycle: "merged" }), pr({ lifecycle: "merged" })),
    ).toBeNull()
  })

  it("merged outranks a simultaneous check flip", () => {
    expect(
      prTransition(
        pr({ checkState: "passing" }),
        pr({ lifecycle: "merged", checkState: "failing" }),
      ),
    ).toBe("merged")
  })

  it("fires ready_to_merge on its rising edge", () => {
    expect(prTransition(pr({}), pr({ lifecycle: "ready_to_merge" }))).toBe(
      "ready_to_merge",
    )
    expect(
      prTransition(
        pr({ lifecycle: "ready_to_merge" }),
        pr({ lifecycle: "ready_to_merge" }),
      ),
    ).toBeNull()
  })

  it("fires check edges while the PR is actionable", () => {
    expect(prTransition(pr({}), pr({ checkState: "failing" }))).toBe(
      "checks_failing",
    )
    expect(
      prTransition(pr({ checkState: "failing" }), pr({ checkState: "passing" })),
    ).toBe("checks_passing")
    expect(prTransition(pr({}), pr({ checkState: "passing" }))).toBe(
      "checks_passing",
    )
  })

  it("repeating the same check state never fires", () => {
    expect(
      prTransition(pr({ checkState: "failing" }), pr({ checkState: "failing" })),
    ).toBeNull()
    expect(
      prTransition(pr({ checkState: "passing" }), pr({ checkState: "passing" })),
    ).toBeNull()
  })

  it("check edges on a closed PR are ignored", () => {
    expect(
      prTransition(pr({}), pr({ lifecycle: "closed", checkState: "failing" })),
    ).toBeNull()
  })
})

describe("prTransitions (snapshot diff)", () => {
  it("page-load hydration (no prev tasks) fires nothing", () => {
    expect(prTransitions([], [task("a", pr({ checkState: "failing" }))])).toEqual(
      [],
    )
  })

  it("diffs only tasks present in both snapshots and carries the label", () => {
    const prev = [task("a", pr({})), task("b", pr({}))]
    const next = [
      task("a", pr({ checkState: "failing" })),
      task("c", pr({ checkState: "failing" })), // new task: ignored
    ]
    expect(prTransitions(prev, next)).toEqual([
      { taskId: "a", taskLabel: "Task a", kind: "checks_failing", number: 7 },
    ])
  })

  it("omits the number when the PR has none", () => {
    const prev = [task("a", pr({ number: undefined }))]
    const next = [task("a", pr({ number: undefined, checkState: "passing" }))]
    expect(prTransitions(prev, next)).toEqual([
      { taskId: "a", taskLabel: "Task a", kind: "checks_passing" },
    ])
  })
})

describe("prTransitionBody", () => {
  it("formats each kind with the PR number when known", () => {
    const base = { taskId: "a", taskLabel: "Task a" } as const
    expect(prTransitionBody({ ...base, kind: "merged", number: 7 })).toBe(
      "PR #7 merged.",
    )
    expect(prTransitionBody({ ...base, kind: "ready_to_merge", number: 7 })).toBe(
      "PR #7 is ready to merge.",
    )
    expect(prTransitionBody({ ...base, kind: "checks_failing" })).toBe(
      "PR checks failing.",
    )
    expect(prTransitionBody({ ...base, kind: "checks_passing", number: 9 })).toBe(
      "PR #9 checks passing.",
    )
  })
})
