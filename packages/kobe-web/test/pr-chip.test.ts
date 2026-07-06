import { describe, expect, it } from "vitest"
import { prChipView } from "../src/lib/pr-chip.ts"
import type { TaskPRStatus } from "../src/lib/types.ts"

// Why this matters: the chip is the rail's AND the Overview's only PR signal.
// The precedence contract — a terminal lifecycle (merged/closed) wins over
// any check state, an open PR is colored by its checks — must hold in both
// surfaces, so it lives in one pure function locked here.

const pr = (over: Partial<TaskPRStatus>): TaskPRStatus => ({
  provider: "github",
  lifecycle: "open",
  checkState: "none",
  number: 42,
  ...over,
})

describe("prChipView", () => {
  it("renders nothing without a PR or with an unknown lifecycle", () => {
    expect(prChipView(undefined)).toBeNull()
    expect(prChipView({})).toBeNull()
    expect(prChipView(pr({ lifecycle: "unknown" }))).toBeNull()
  })

  it("terminal lifecycle beats check state", () => {
    expect(prChipView(pr({ lifecycle: "merged", checkState: "failing" }))?.cls)
      .toBe("text-kobe-violet")
    expect(prChipView(pr({ lifecycle: "closed", checkState: "passing" }))?.cls)
      .toBe("text-kobe-red")
  })

  it("an open PR is colored by its checks", () => {
    expect(prChipView(pr({ checkState: "failing" }))?.cls).toBe(
      "text-kobe-red",
    )
    expect(prChipView(pr({ checkState: "passing" }))?.cls).toBe(
      "text-kobe-green",
    )
    expect(prChipView(pr({ checkState: "pending" }))?.cls).toBe(
      "text-kobe-yellow",
    )
    expect(prChipView(pr({ checkState: "none" }))?.cls).toBe("text-kobe-blue")
    expect(prChipView(pr({ checkState: undefined }))?.cls).toBe(
      "text-kobe-blue",
    )
  })

  it("non-terminal lifecycles render (creating / ready_to_merge)", () => {
    expect(prChipView(pr({ lifecycle: "creating" }))).not.toBeNull()
    expect(
      prChipView(pr({ lifecycle: "ready_to_merge", checkState: "passing" }))
        ?.cls,
    ).toBe("text-kobe-green")
  })

  it("labels with the PR number when known", () => {
    expect(prChipView(pr({}))?.label).toBe("PR #42")
    expect(prChipView(pr({ number: undefined }))?.label).toBe("PR")
  })

  it("hover title carries lifecycle plus a meaningful check state", () => {
    expect(prChipView(pr({ checkState: "failing" }))?.title).toBe(
      "open · failing",
    )
    expect(prChipView(pr({ checkState: "none" }))?.title).toBe("open")
    expect(prChipView(pr({ checkState: undefined }))?.title).toBe("open")
  })
})
