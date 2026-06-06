import { describe, expect, it } from "vitest"
import { findAdoptableWorktree, matchRepoByCwd, matchTaskByCwd } from "../../src/daemon/cwd-task.ts"

describe("matchTaskByCwd", () => {
  const main = { id: "main", worktreePath: "/repo" }
  const sub = { id: "sub", worktreePath: "/repo/.kobe/worktrees/snipe" }
  const other = { id: "other", worktreePath: "/elsewhere/proj" }
  const tasks = [main, sub, other]

  it("matches an exact worktree path", () => {
    expect(matchTaskByCwd(tasks, "/elsewhere/proj")).toBe("other")
  })

  it("matches a cwd inside a worktree", () => {
    expect(matchTaskByCwd(tasks, "/elsewhere/proj/src/deep")).toBe("other")
  })

  it("prefers the longest (most specific) worktree — sub-task over its repo root", () => {
    // A sub-task's worktree lives UNDER the main task's repo root, so the cwd
    // prefix-matches both; the longer path must win.
    expect(matchTaskByCwd(tasks, "/repo/.kobe/worktrees/snipe")).toBe("sub")
    expect(matchTaskByCwd(tasks, "/repo/.kobe/worktrees/snipe/pkg")).toBe("sub")
  })

  it("falls back to the repo-root (main) task for a cwd not under any sub-worktree", () => {
    expect(matchTaskByCwd(tasks, "/repo/src")).toBe("main")
    expect(matchTaskByCwd(tasks, "/repo")).toBe("main")
  })

  it("returns undefined for an unrelated cwd", () => {
    expect(matchTaskByCwd(tasks, "/totally/unrelated")).toBeUndefined()
  })

  it("ignores tasks with no worktree path", () => {
    expect(matchTaskByCwd([{ id: "x" }, { id: "y", worktreePath: null }], "/repo")).toBeUndefined()
  })

  it("does not treat a sibling-prefix dir as a match (/repo vs /repo-other)", () => {
    expect(matchTaskByCwd([main], "/repo-other/src")).toBeUndefined()
  })

  it("tolerates a trailing slash on either side", () => {
    expect(matchTaskByCwd([{ id: "z", worktreePath: "/repo/wt/" }], "/repo/wt")).toBe("z")
    expect(matchTaskByCwd([{ id: "z", worktreePath: "/repo/wt" }], "/repo/wt/")).toBe("z")
  })
})

describe("matchRepoByCwd", () => {
  const tasks = [
    { id: "main", repo: "/repo", worktreePath: "/repo" },
    { id: "sub", repo: "/repo", worktreePath: "/repo/.kobe/worktrees/known" },
    { id: "other", repo: "/elsewhere/proj", worktreePath: "/elsewhere/proj" },
  ]

  it("maps a cwd at the repo root to that repo", () => {
    expect(matchRepoByCwd(tasks, "/repo")).toBe("/repo")
  })

  it("maps a cwd inside the repo (or a worktree under it) to the repo root", () => {
    expect(matchRepoByCwd(tasks, "/repo/src/deep")).toBe("/repo")
    // A `git worktree add` run from inside an existing worktree still resolves
    // to the tracked repo root (the longest repo prefix).
    expect(matchRepoByCwd(tasks, "/repo/.kobe/worktrees/known")).toBe("/repo")
  })

  it("prefers the longest (most specific) repo when repos nest", () => {
    const nested = [
      { id: "outer", repo: "/repo", worktreePath: "/repo" },
      { id: "inner", repo: "/repo/vendor/lib", worktreePath: "/repo/vendor/lib" },
    ]
    expect(matchRepoByCwd(nested, "/repo/vendor/lib/src")).toBe("/repo/vendor/lib")
  })

  it("returns undefined for a cwd not under any tracked repo", () => {
    expect(matchRepoByCwd(tasks, "/totally/unrelated")).toBeUndefined()
  })

  it("does not treat a sibling-prefix dir as a match (/repo vs /repo-other)", () => {
    expect(matchRepoByCwd(tasks, "/repo-other/src")).toBeUndefined()
  })

  it("ignores tasks with no repo", () => {
    expect(matchRepoByCwd([{ id: "x", worktreePath: "/repo" }], "/repo")).toBeUndefined()
  })
})

describe("findAdoptableWorktree", () => {
  // kobe tracks repo "/repo" (main task) + one sub-task worktree.
  const tasks = [
    { id: "main", repo: "/repo", worktreePath: "/repo" },
    { id: "sub", repo: "/repo", worktreePath: "/repo/.kobe/worktrees/known" },
    { id: "legacy", repo: "/repo", worktreePath: "/repo/.claude/worktrees/old" },
  ]

  it("adopts an external worktree under a tracked repo's .kobe/worktrees", () => {
    expect(findAdoptableWorktree(tasks, "/repo/.kobe/worktrees/external")).toEqual({
      repo: "/repo",
      worktreePath: "/repo/.kobe/worktrees/external",
    })
  })

  it("still adopts legacy external worktrees under a tracked repo's .claude/worktrees", () => {
    expect(findAdoptableWorktree(tasks, "/repo/.claude/worktrees/external")).toEqual({
      repo: "/repo",
      worktreePath: "/repo/.claude/worktrees/external",
    })
  })

  it("derives the worktree dir even when cwd is a subdir of it", () => {
    expect(findAdoptableWorktree(tasks, "/repo/.kobe/worktrees/external/src/deep")).toEqual({
      repo: "/repo",
      worktreePath: "/repo/.kobe/worktrees/external",
    })
  })

  it("returns undefined when that worktree is already a task", () => {
    expect(findAdoptableWorktree(tasks, "/repo/.kobe/worktrees/known")).toBeUndefined()
    expect(findAdoptableWorktree(tasks, "/repo/.kobe/worktrees/known/pkg")).toBeUndefined()
    expect(findAdoptableWorktree(tasks, "/repo/.claude/worktrees/old")).toBeUndefined()
  })

  it("ignores a cwd at the repo root or in a normal subdir (not a worktree)", () => {
    expect(findAdoptableWorktree(tasks, "/repo")).toBeUndefined()
    expect(findAdoptableWorktree(tasks, "/repo/src")).toBeUndefined()
  })

  it("ignores a cwd under an UNtracked repo", () => {
    expect(findAdoptableWorktree(tasks, "/other/.kobe/worktrees/x")).toBeUndefined()
  })

  it("ignores a sibling-prefix repo (/repo vs /repo-other)", () => {
    expect(findAdoptableWorktree(tasks, "/repo-other/.kobe/worktrees/x")).toBeUndefined()
  })
})
