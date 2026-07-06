/**
 * Unit tests for `src/tui/lib/git-snapshot.ts` — the one-shot sync git
 * helpers the new-task dialog and quick-task lean on.
 *
 * Why these matter: this module is THE sync-subprocess whitelist entry
 * for `src/tui/**` (see test/tui/render-path-sync-guard.test.ts), so
 * its degrade-to-null/[] contract must hold — a thrown error or a
 * hang here would surface inside a dialog keystroke. We pin behavior
 * against a throwaway tmpdir git repo (never the working repo, whose
 * branch set varies):
 *   - validateRepoPath's three reasons (missing / not a dir / not a
 *     repo) and the null happy path.
 *   - getCurrentBranch reads the checked-out branch and degrades to
 *     null for non-repos.
 *   - listLocalBranches sorts default branches (main, master, develop)
 *     first and degrades to [] for non-repos.
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { DEFAULT_BASE_REF, getCurrentBranch, listLocalBranches, validateRepoPath } from "@/tui/lib/git-snapshot"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let root: string
let repo: string
let notRepo: string
let plainFile: string

function git(cwd: string, ...args: string[]): void {
  const out = spawnSync("git", args, { cwd, encoding: "utf-8" })
  if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`)
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-git-snapshot-test-"))
  repo = path.join(root, "repo")
  notRepo = path.join(root, "not-repo")
  plainFile = path.join(root, "file.txt")
  fs.mkdirSync(repo)
  fs.mkdirSync(notRepo)
  fs.writeFileSync(plainFile, "x")
  git(repo, "init", "-b", "zeta")
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init")
  for (const b of ["develop", "master", "main", "feature-x"]) git(repo, "branch", b)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("validateRepoPath", () => {
  it("names the failure: missing path, non-directory, non-repo", () => {
    expect(validateRepoPath("")).toBe("repo path is required")
    expect(validateRepoPath(path.join(root, "missing"))).toContain("path does not exist")
    expect(validateRepoPath(plainFile)).toContain("not a directory")
    // Non-repo: friendly copy that explains the why and hands over the fix.
    const nonRepo = validateRepoPath(notRepo)
    expect(nonRepo).toContain("isn't a git repository")
    expect(nonRepo).toContain("git init")
  })

  it("returns null for a usable git repo", () => {
    expect(validateRepoPath(repo)).toBeNull()
  })
})

describe("getCurrentBranch", () => {
  it("reads the checked-out branch", () => {
    expect(getCurrentBranch(repo)).toBe("zeta")
  })

  it("degrades to null for non-repos and empty input", () => {
    expect(getCurrentBranch(notRepo)).toBeNull()
    expect(getCurrentBranch("")).toBeNull()
  })
})

describe("listLocalBranches", () => {
  it("sorts default branches first: main, master, develop, then the rest", () => {
    expect(listLocalBranches(repo)).toEqual(["main", "master", "develop", "feature-x", "zeta"])
  })

  it("degrades to [] for non-repos and empty input", () => {
    expect(listLocalBranches(notRepo)).toEqual([])
    expect(listLocalBranches("")).toEqual([])
  })
})

describe("DEFAULT_BASE_REF", () => {
  it("is main — the blank-field / unreadable-HEAD fallback", () => {
    expect(DEFAULT_BASE_REF).toBe("main")
  })
})
