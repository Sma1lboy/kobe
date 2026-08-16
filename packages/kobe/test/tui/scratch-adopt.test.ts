/**
 * Scratch adoption decision + the cwd read behind it (issue #33). The
 * decision is the confidence gate: a repo alone (browsing) or a harness
 * alone (working in a non-repo) must both stay in Scratch.
 */

import { describe, expect, it } from "vitest"
import { parseLsofCwd, processCwd } from "../../src/engine/process-cwd"
import { decideScratchAdopt } from "../../src/tui/workspace/scratch-adopt"

describe("decideScratchAdopt", () => {
  const known = new Set(["/repos/kobe"])

  it("repo + live harness → adopt, flagged known/unfamiliar", () => {
    expect(decideScratchAdopt({ repoRoot: "/repos/kobe", harnessLive: true, knownRepos: known })).toEqual({
      kind: "adopt",
      repo: "/repos/kobe",
      known: true,
    })
    expect(decideScratchAdopt({ repoRoot: "/repos/other", harnessLive: true, knownRepos: known })).toEqual({
      kind: "adopt",
      repo: "/repos/other",
      known: false,
    })
  })

  it("repo without a harness stays — a cd is browsing, not working", () => {
    expect(decideScratchAdopt({ repoRoot: "/repos/kobe", harnessLive: false, knownRepos: known })).toEqual({
      kind: "stay",
    })
  })

  it("harness without repo semantics stays in Scratch", () => {
    expect(decideScratchAdopt({ repoRoot: null, harnessLive: true, knownRepos: known })).toEqual({ kind: "stay" })
  })
})

describe("processCwd", () => {
  it("parses lsof -Fn output", () => {
    expect(parseLsofCwd("p123\nfcwd\nn/Users/me/repos/kobe\n")).toBe("/Users/me/repos/kobe")
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
