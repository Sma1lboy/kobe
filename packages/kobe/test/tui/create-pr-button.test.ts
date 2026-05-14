import { describe, expect, test } from "vitest"
import { describePRChip, shouldPollPRStatus } from "../../src/tui/component/create-pr-state.ts"
import type { TaskPRStatus } from "../../src/types/task.ts"

function st(overrides: Partial<TaskPRStatus>): TaskPRStatus {
  return {
    provider: "github",
    lifecycle: "open",
    checkState: "unknown",
    ...overrides,
  }
}

describe("CreatePRButton state helpers", () => {
  test("renders the default create prompt when no GitHub status exists", () => {
    expect(describePRChip(undefined)).toEqual({ key: "[PR]", label: "Create PR", tone: "normal" })
    expect(describePRChip(st({ provider: "gitlab" }))).toEqual({ key: "[PR]", label: "Create PR", tone: "normal" })
  })

  test("renders GitHub CI and merge states", () => {
    expect(describePRChip(st({ lifecycle: "creating" }))).toMatchObject({ label: "Finding PR", tone: "warning" })
    expect(describePRChip(st({ checkState: "pending" }))).toMatchObject({ label: "CI pending", tone: "warning" })
    expect(describePRChip(st({ checkState: "failing" }))).toMatchObject({ label: "CI failing", tone: "error" })
    expect(describePRChip(st({ lifecycle: "ready_to_merge", checkState: "passing" }))).toEqual({
      key: "[Merge]",
      label: "Ready to merge",
      tone: "accent",
    })
  })

  test("polls only active GitHub states", () => {
    expect(shouldPollPRStatus(st({ lifecycle: "creating" }))).toBe(true)
    expect(shouldPollPRStatus(st({ lifecycle: "open" }))).toBe(true)
    expect(shouldPollPRStatus(st({ lifecycle: "ready_to_merge" }))).toBe(false)
    expect(shouldPollPRStatus(st({ provider: "bitbucket" }))).toBe(false)
  })
})
