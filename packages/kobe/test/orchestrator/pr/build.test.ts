/**
 * Unit tests for `gatherPRState`.
 *
 * Sets up tiny fixture repos under `os.tmpdir()` using `execFileSync` —
 * each test owns its own repo so the fixtures stay independent. Covers:
 *
 *   - branch detection (a regular branch + the detached-HEAD case).
 *   - dirty count (clean vs 1 vs N untracked files).
 *   - hasUpstream true / false.
 *   - targetBranch fallback to 'main' when origin/HEAD doesn't resolve.
 *   - targetBranch from origin/HEAD when it does resolve.
 */

import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { gatherPRState } from "../../../src/orchestrator/pr/build.ts"

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kobe-pr-build-"))
  git(dir, ["init", "--quiet", "--initial-branch=main"])
  git(dir, ["config", "user.email", "harness@kobe.test"])
  git(dir, ["config", "user.name", "kobe harness"])
  git(dir, ["config", "commit.gpgsign", "false"])
  await fs.writeFile(path.join(dir, "README.md"), "# fixture\n", "utf8")
  git(dir, ["add", "README.md"])
  git(dir, ["commit", "--quiet", "-m", "init"])
  return dir
}

let repos: string[] = []

beforeEach(() => {
  repos = []
})

afterEach(async () => {
  for (const r of repos) {
    try {
      await fs.rm(r, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  repos = []
})

async function track(repo: string): Promise<string> {
  repos.push(repo)
  return repo
}

describe("gatherPRState", () => {
  test("clean main branch, no upstream → branch=main, dirty=0, upstream=false, target=main", async () => {
    const repo = await track(await makeRepo())
    const s = await gatherPRState(repo)
    expect(s.branch).toBe("main")
    expect(s.dirtyCount).toBe(0)
    expect(s.hasUpstream).toBe(false)
    // No origin → fallback to 'main'.
    expect(s.targetBranch).toBe("main")
  })

  test("non-main branch reflected in branch field", async () => {
    const repo = await track(await makeRepo())
    git(repo, ["checkout", "-b", "feature/cool"])
    const s = await gatherPRState(repo)
    expect(s.branch).toBe("feature/cool")
  })

  test("detached HEAD surfaces as 'HEAD'", async () => {
    const repo = await track(await makeRepo())
    const sha = git(repo, ["rev-parse", "HEAD"])
    git(repo, ["checkout", "--quiet", sha])
    const s = await gatherPRState(repo)
    expect(s.branch).toBe("HEAD")
  })

  test("dirty count: 1 untracked file → 1", async () => {
    const repo = await track(await makeRepo())
    await fs.writeFile(path.join(repo, "new.txt"), "x", "utf8")
    const s = await gatherPRState(repo)
    expect(s.dirtyCount).toBe(1)
  })

  test("dirty count: 3 changes → 3", async () => {
    const repo = await track(await makeRepo())
    await fs.writeFile(path.join(repo, "a.txt"), "a", "utf8")
    await fs.writeFile(path.join(repo, "b.txt"), "b", "utf8")
    await fs.writeFile(path.join(repo, "README.md"), "modified\n", "utf8")
    const s = await gatherPRState(repo)
    expect(s.dirtyCount).toBe(3)
  })

  test("hasUpstream true when branch tracks a remote ref", async () => {
    // Bare "origin" repo, push, then set upstream.
    const repo = await track(await makeRepo())
    const remote = await track(await fs.mkdtemp(path.join(os.tmpdir(), "kobe-pr-remote-")))
    git(remote, ["init", "--quiet", "--bare"])
    git(repo, ["remote", "add", "origin", remote])
    git(repo, ["push", "--quiet", "-u", "origin", "main"])
    const s = await gatherPRState(repo)
    expect(s.hasUpstream).toBe(true)
  })

  test("targetBranch falls back to 'main' when origin/HEAD is unset", async () => {
    // Add origin but never run `git remote set-head` — origin/HEAD won't resolve.
    const repo = await track(await makeRepo())
    const remote = await track(await fs.mkdtemp(path.join(os.tmpdir(), "kobe-pr-remote-")))
    git(remote, ["init", "--quiet", "--bare"])
    git(repo, ["remote", "add", "origin", remote])
    git(repo, ["push", "--quiet", "origin", "main"])
    const s = await gatherPRState(repo)
    expect(s.targetBranch).toBe("main")
  })

  test("targetBranch reflects origin/HEAD when set", async () => {
    const repo = await track(await makeRepo())
    const remote = await track(await fs.mkdtemp(path.join(os.tmpdir(), "kobe-pr-remote-")))
    git(remote, ["init", "--quiet", "--bare"])
    git(repo, ["remote", "add", "origin", remote])
    // Push the branch under a non-default name so origin/HEAD points there.
    git(repo, ["checkout", "-b", "trunk"])
    git(repo, ["push", "--quiet", "-u", "origin", "trunk"])
    // Manually set origin/HEAD to trunk (the bare init has its own HEAD).
    git(repo, ["remote", "set-head", "origin", "trunk"])
    const s = await gatherPRState(repo)
    expect(s.targetBranch).toBe("trunk")
  })

  test("non-existent worktree path falls back gracefully (no throw)", async () => {
    const ghost = path.join(os.tmpdir(), `kobe-pr-build-nonexistent-${Date.now()}`)
    const s = await gatherPRState(ghost)
    expect(s.branch).toBe("HEAD")
    expect(s.dirtyCount).toBe(0)
    expect(s.hasUpstream).toBe(false)
    expect(s.targetBranch).toBe("main")
  })
})
