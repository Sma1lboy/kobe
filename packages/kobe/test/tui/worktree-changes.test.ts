import { describe, expect, test } from "vitest"
import { parsePorcelain, pickPushedChanges, sameWorktreeChanges } from "../../src/tui/panes/sidebar/worktree-changes"

describe("parsePorcelain", () => {
  test("returns zeros for empty input", () => {
    expect(parsePorcelain("")).toEqual({ added: 0, deleted: 0 })
  })

  test("counts modified, added, untracked as `added`", () => {
    const text = [" M src/a.ts", "M  src/b.ts", "A  src/c.ts", "?? src/d.ts", ""].join("\n")
    expect(parsePorcelain(text)).toEqual({ added: 4, deleted: 0 })
  })

  test("counts deletions in either column as `deleted`", () => {
    const text = [" D src/a.ts", "D  src/b.ts", "AD src/c.ts", ""].join("\n")
    expect(parsePorcelain(text)).toEqual({ added: 0, deleted: 3 })
  })

  test("ignores branch-header line if present", () => {
    const text = ["## main...origin/main [ahead 2, behind 1]", " M src/a.ts", " D src/b.ts", ""].join("\n")
    expect(parsePorcelain(text)).toEqual({ added: 1, deleted: 1 })
  })

  test("clean tree yields zeros", () => {
    expect(parsePorcelain("\n")).toEqual({ added: 0, deleted: 0 })
  })
})

describe("pickPushedChanges", () => {
  const pushed = new Map([["/wt/a", { added: 3, deleted: 1 }]])

  test("null/undefined map → null (local-poller fallback engages)", () => {
    expect(pickPushedChanges(null, "/wt/a")).toBeNull()
    expect(pickPushedChanges(undefined, "/wt/a")).toBeNull()
  })

  test("a tracked worktree reads its pushed counts", () => {
    expect(pickPushedChanges(pushed, "/wt/a")).toEqual({ added: 3, deleted: 1 })
  })

  test("a worktree absent from a non-null map reads zeros, not fallback", () => {
    expect(pickPushedChanges(pushed, "/wt/archived")).toEqual({ added: 0, deleted: 0 })
  })

  test("absent keys share one zeros reference (memo-equality friendly)", () => {
    expect(pickPushedChanges(pushed, "/wt/x")).toBe(pickPushedChanges(new Map(), "/wt/y"))
  })
})

describe("sameWorktreeChanges", () => {
  test("compares both counts", () => {
    expect(sameWorktreeChanges({ added: 1, deleted: 2 }, { added: 1, deleted: 2 })).toBe(true)
    expect(sameWorktreeChanges({ added: 1, deleted: 2 }, { added: 1, deleted: 3 })).toBe(false)
    expect(sameWorktreeChanges({ added: 0, deleted: 0 }, { added: 1, deleted: 0 })).toBe(false)
  })
})
