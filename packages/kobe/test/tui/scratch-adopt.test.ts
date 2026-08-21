/**
 * Scratch adoption decision + the cwd read behind it (issues #33/#40). The
 * decision is the confidence gate: a repo alone (browsing) or a harness
 * alone (working in a non-repo) must both stay in Scratch. Once confident,
 * the fold check (#40) de-dupes against existing tasks so migrating a shell
 * parked in an already-tracked directory never mints a duplicate row.
 */

import { describe, expect, it } from "vitest"
import { parseLsofCwd, processCwd } from "../../src/engine/process-cwd"
import { type ScratchOwnerTask, decideScratchAdopt } from "../../src/tui/workspace/scratch-adopt"

describe("decideScratchAdopt", () => {
  const known = new Set(["/repos/rove"])
  const none: ScratchOwnerTask[] = []

  it("repo + live harness, no owner → adopt, flagged known/unfamiliar", () => {
    expect(
      decideScratchAdopt({
        cwd: "/repos/rove/src",
        repoRoot: "/repos/rove",
        harnessLive: true,
        knownRepos: known,
        ownerTasks: none,
      }),
    ).toEqual({ kind: "adopt", repo: "/repos/rove", known: true })
    expect(
      decideScratchAdopt({
        cwd: "/repos/other",
        repoRoot: "/repos/other",
        harnessLive: true,
        knownRepos: known,
        ownerTasks: none,
      }),
    ).toEqual({ kind: "adopt", repo: "/repos/other", known: false })
  })

  it("repo without a harness stays — a cd is browsing, not working", () => {
    expect(
      decideScratchAdopt({
        cwd: "/repos/rove",
        repoRoot: "/repos/rove",
        harnessLive: false,
        knownRepos: known,
        ownerTasks: none,
      }),
    ).toEqual({ kind: "stay" })
  })

  it("harness without repo semantics stays in Scratch", () => {
    expect(
      decideScratchAdopt({ cwd: "/home/me", repoRoot: null, harnessLive: true, knownRepos: known, ownerTasks: none }),
    ).toEqual({ kind: "stay" })
  })

  // --- issue #40: fold instead of minting a duplicate row -----------------

  const mainTask: ScratchOwnerTask = { id: "T-main", kind: "main", dir: "/repos/rove" }
  const managed: ScratchOwnerTask = { id: "T-wt", kind: "task", dir: "/wt/kobe/feature-x" }
  const dirTask: ScratchOwnerTask = { id: "T-dir", kind: "dir", dir: "/repos/rove" }

  it("cwd exactly a main task's directory → fold into it", () => {
    expect(
      decideScratchAdopt({
        cwd: "/repos/rove",
        repoRoot: "/repos/rove",
        harnessLive: true,
        knownRepos: known,
        ownerTasks: [mainTask],
      }),
    ).toEqual({ kind: "fold", taskId: "T-main" })
  })

  it("cwd inside a managed task's worktree → fold into that task, not the main row", () => {
    // resolveMainRepoRoot maps a linked worktree back to the MAIN checkout,
    // so the managed subtree check must win over the repo-root match.
    expect(
      decideScratchAdopt({
        cwd: "/wt/kobe/feature-x/src",
        repoRoot: "/repos/rove",
        harnessLive: true,
        knownRepos: known,
        ownerTasks: [mainTask, managed],
      }),
    ).toEqual({ kind: "fold", taskId: "T-wt" })
  })

  it("cwd in a SUBDIR of the main checkout still folds — the adopt would pin the same root", () => {
    expect(
      decideScratchAdopt({
        cwd: "/repos/rove/packages/kobe",
        repoRoot: "/repos/rove",
        harnessLive: true,
        knownRepos: known,
        ownerTasks: [mainTask],
      }),
    ).toEqual({ kind: "fold", taskId: "T-main" })
  })

  it("main row wins over a dir row for the same directory", () => {
    expect(
      decideScratchAdopt({
        cwd: "/repos/rove",
        repoRoot: "/repos/rove",
        harnessLive: true,
        knownRepos: known,
        ownerTasks: [dirTask, mainTask],
      }),
    ).toEqual({ kind: "fold", taskId: "T-main" })
  })

  it("cwd with no owning task → the existing adopt path (no fold)", () => {
    expect(
      decideScratchAdopt({
        cwd: "/repos/other",
        repoRoot: "/repos/other",
        harnessLive: true,
        knownRepos: known,
        ownerTasks: [mainTask, managed, dirTask],
      }),
    ).toEqual({ kind: "adopt", repo: "/repos/other", known: false })
  })

  it("a dir task elsewhere in the repo does not capture a shell at the root", () => {
    // dir tasks own exactly their directory; only the exact-dir or
    // pinned-root match folds.
    const sub: ScratchOwnerTask = { id: "T-sub", kind: "dir", dir: "/repos/rove/packages/kobe" }
    expect(
      decideScratchAdopt({
        cwd: "/repos/rove/docs",
        repoRoot: "/repos/rove",
        harnessLive: true,
        knownRepos: known,
        ownerTasks: [sub],
      }),
    ).toEqual({ kind: "adopt", repo: "/repos/rove", known: true })
  })
})

describe("processCwd", () => {
  it("parses lsof -Fn output", () => {
    expect(parseLsofCwd("p123\nfcwd\nn/Users/me/repos/rove\n")).toBe("/Users/me/repos/rove")
    expect(parseLsofCwd("")).toBeNull()
  })

  it("answers null for an invalid pid and a failing lsof", async () => {
    expect(await processCwd(0)).toBeNull()
    expect(
      await processCwd(999999999, async () => {
        throw new Error("no such process")
      }),
    ).toBeNull()
  })
})
