import { describe, expect, it } from "vitest"
import {
  normalizeRepoPath,
  pruneSnapshotAliases,
  type RepoPaths,
  repoSnapshotAliases,
} from "../src/lib/repo-key.ts"

/**
 * repo-key is the single home for the issue-snapshot aliasing contract that
 * used to be copy-pasted across store.ts, daemon-link.ts, and use-repo-issues.ts.
 * These tests pin the contract so the three consumers can't silently diverge.
 */

describe("normalizeRepoPath", () => {
  it("drops a trailing slash", () => {
    expect(normalizeRepoPath("/repo/")).toBe("/repo")
  })

  it("collapses repeated trailing slashes", () => {
    expect(normalizeRepoPath("/repo///")).toBe("/repo")
  })

  it("leaves a path without a trailing slash untouched", () => {
    expect(normalizeRepoPath("/repo")).toBe("/repo")
  })

  it("keeps a lone root slash", () => {
    expect(normalizeRepoPath("/")).toBe("/")
  })
})

describe("repoSnapshotAliases", () => {
  const tasks: RepoPaths[] = [
    {
      repo: "/Users/narwhal/proj/kobe/",
      worktreePath: "/Users/narwhal/.kobe/worktrees/kobe/bovid",
    },
  ]

  it("maps a worktree issue push back to its source repo key", () => {
    expect(
      repoSnapshotAliases(tasks, "/Users/narwhal/.kobe/worktrees/kobe/bovid"),
    ).toEqual([
      "/Users/narwhal/.kobe/worktrees/kobe/bovid",
      "/Users/narwhal/proj/kobe/",
    ])
  })

  it("maps a source repo issue push to known worktree keys too", () => {
    expect(repoSnapshotAliases(tasks, "/Users/narwhal/proj/kobe")).toEqual([
      "/Users/narwhal/proj/kobe",
      "/Users/narwhal/proj/kobe/",
      "/Users/narwhal/.kobe/worktrees/kobe/bovid",
    ])
  })

  it("matches across a trailing-slash difference (the cache-split bug)", () => {
    // A push under `/repo` must still alias to a task that stored `/repo/`.
    expect(repoSnapshotAliases(tasks, "/Users/narwhal/proj/kobe/")).toContain(
      "/Users/narwhal/.kobe/worktrees/kobe/bovid",
    )
  })

  it("returns just the raw repoRoot when no task matches", () => {
    expect(repoSnapshotAliases(tasks, "/some/other/repo")).toEqual([
      "/some/other/repo",
    ])
  })

  it("accepts the structural shape — extra task fields are ignored", () => {
    // Proves both the SPA `Task` and the daemon `SerializedTask` satisfy it:
    // only `repo` + `worktreePath` are read.
    const wide = [
      {
        id: "t1",
        title: "x",
        repo: "/p",
        worktreePath: "/w",
        status: "backlog",
      },
    ]
    expect(repoSnapshotAliases(wide, "/p")).toEqual(["/p", "/w"])
  })
})

describe("pruneSnapshotAliases", () => {
  const tasks: RepoPaths[] = [
    { repo: "/proj/kobe/", worktreePath: "/wt/kobe/live" },
  ]

  it("drops alias keys left behind by deleted tasks", () => {
    const snapshots = {
      "/proj/kobe": { n: 1 },
      "/wt/kobe/live": { n: 1 },
      "/wt/kobe/deleted-task": { n: 1 },
      "/some/other/repo": { n: 2 },
    }
    expect(Object.keys(pruneSnapshotAliases(snapshots, tasks))).toEqual([
      "/proj/kobe",
      "/wt/kobe/live",
    ])
  })

  it("keeps a key that differs from a live task path only by trailing slash", () => {
    const snapshots = { "/proj/kobe/": { n: 1 } }
    expect(pruneSnapshotAliases(snapshots, tasks)).toEqual(snapshots)
  })

  it("returns the SAME object when nothing was pruned", () => {
    const snapshots = { "/wt/kobe/live": { n: 1 } }
    expect(pruneSnapshotAliases(snapshots, tasks)).toBe(snapshots)
  })

  it("empties the cache when no tasks remain", () => {
    expect(pruneSnapshotAliases({ "/proj/kobe": { n: 1 } }, [])).toEqual({})
  })
})
