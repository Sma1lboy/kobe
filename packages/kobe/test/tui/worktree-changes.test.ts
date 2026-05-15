import { describe, expect, test } from "vitest"
import { parsePorcelain } from "../../src/tui/panes/sidebar/worktree-changes"

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
