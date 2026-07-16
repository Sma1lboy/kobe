/**
 * Committed-work signals behind `collect` (branch-signals.ts): base-ref
 * resolution order, shortstat parsing, and the end-to-end read against a
 * real throwaway repo — the seam that makes "pick the fan-out winner"
 * possible once attempts start committing (uncommitted counts read 0/0).
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseShortstat, readBranchSignals, resolveBaseRef } from "../../src/cli/api/branch-signals.ts"

const cleanups: string[] = []

afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd, stdio: "ignore" })
}

/** Repo with a `main` base and a task branch carrying one committed change. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "kobe-branch-signals-"))
  cleanups.push(repo)
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(join(repo, "a.txt"), "one\n")
  git(repo, "add", "a.txt")
  git(repo, "commit", "-q", "-m", "base")
  git(repo, "checkout", "-q", "-b", "kobe/task")
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n")
  writeFileSync(join(repo, "b.txt"), "new\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "attempt work")
  return repo
}

describe("parseShortstat", () => {
  it("parses all three clauses", () => {
    expect(parseShortstat(" 3 files changed, 40 insertions(+), 2 deletions(-)")).toEqual({
      files: 3,
      insertions: 40,
      deletions: 2,
    })
  })

  it("tolerates missing clauses and the singular forms", () => {
    expect(parseShortstat(" 1 file changed, 1 insertion(+)")).toEqual({ files: 1, insertions: 1, deletions: 0 })
    expect(parseShortstat("")).toEqual({ files: 0, insertions: 0, deletions: 0 })
  })
})

describe("readBranchSignals", () => {
  it("reports ahead count + committed diffstat vs the local main base", () => {
    const repo = makeRepo()
    const signals = readBranchSignals(repo)
    expect(signals.baseRef).toBe("main")
    expect(signals.ahead).toBe(1)
    expect(signals.diff).toEqual({ files: 2, insertions: 2, deletions: 0 })
  })

  it("yields nulls (never throws) outside a git repo or with no base", () => {
    const dir = mkdtempSync(join(tmpdir(), "kobe-branch-signals-plain-"))
    cleanups.push(dir)
    expect(readBranchSignals(dir)).toEqual({ baseRef: null, ahead: null, diff: null })
    expect(readBranchSignals("")).toEqual({ baseRef: null, ahead: null, diff: null })
    expect(resolveBaseRef(dir)).toBeNull()
  })
})
