/**
 * `landTask` integration tests — real git in a tmp repo (no mocks), same
 * rationale as `worktree.test.ts`: the whole job is git's merge/squash/conflict
 * surface, so mocking it would just test the mock.
 *
 * Covers the three branches that matter: a clean merge lands and reports the
 * base branch + commit; squash collapses to one commit; a conflict aborts (base
 * checkout left clean) and throws `LandConflictError` with the file list.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { LandConflictError, MainCheckoutDirtyError } from "../../src/orchestrator/errors.ts"
import { landTask } from "../../src/orchestrator/land.ts"
import type { Task } from "../../src/types/task.ts"
import { toTaskId } from "../../src/types/task.ts"

let tmpRoot: string
let repo: string

function git(args: string[], cwd: string): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`)
}

function write(rel: string, body: string): void {
  fs.writeFileSync(path.join(repo, rel), body)
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-land-"))
  repo = path.join(tmpRoot, "repo")
  fs.mkdirSync(repo)
  git(["init", "-b", "main"], repo)
  git(["config", "user.email", "t@t.t"], repo)
  git(["config", "user.name", "t"], repo)
  write("a.txt", "base\n")
  git(["add", "."], repo)
  git(["commit", "-m", "base"], repo)
})

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // ignored
  }
})

/** A minimal task whose branch is `branch`, rooted at the local repo. */
function task(branch: string): Task {
  const now = new Date().toISOString()
  return {
    id: toTaskId("t-land"),
    title: "t",
    repo,
    branch,
    worktreePath: "",
    status: "backlog",
    kind: "task",
    archived: false,
    createdAt: now,
    updatedAt: now,
  }
}

describe("landTask", () => {
  test("clean merge lands the branch and reports base + commit", async () => {
    git(["checkout", "-b", "feat"], repo)
    write("b.txt", "feature\n")
    git(["add", "."], repo)
    git(["commit", "-m", "feat commit"], repo)
    git(["checkout", "main"], repo)

    const res = await landTask(task("feat"))
    expect(res.landedOn).toBe("main")
    expect(res.strategy).toBe("merge")
    expect(res.commit).toMatch(/^[0-9a-f]+$/)
    expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(true)
  })

  test("squash lands as a single commit", async () => {
    git(["checkout", "-b", "feat"], repo)
    write("b.txt", "feature\n")
    git(["add", "."], repo)
    git(["commit", "-m", "feat commit"], repo)
    git(["checkout", "main"], repo)

    const res = await landTask(task("feat"), { strategy: "squash" })
    expect(res.strategy).toBe("squash")
    // A squash merge is a normal (single-parent) commit — not a merge commit.
    const parents = spawnSync("git", ["rev-list", "--parents", "-1", "HEAD"], { cwd: repo, encoding: "utf8" })
      .stdout.trim()
      .split(/\s+/)
    expect(parents.length).toBe(2) // <commit> <one-parent>
  })

  test("conflict aborts, leaves base clean, throws with the file list", async () => {
    git(["checkout", "-b", "feat"], repo)
    write("a.txt", "feature edit\n")
    git(["commit", "-am", "feat edit"], repo)
    git(["checkout", "main"], repo)
    write("a.txt", "main edit\n")
    git(["commit", "-am", "main edit"], repo)

    await expect(landTask(task("feat"))).rejects.toBeInstanceOf(LandConflictError)
    // Base checkout must be clean after the abort (no half-merge left behind).
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout.trim()
    expect(status).toBe("")
  })

  test("merge refuses a branch with nothing to land (already merged / no commits ahead)", async () => {
    // `feat` branches off main but adds no commits of its own, so it is fully
    // merged into main from the start. `git merge --no-ff` exits 0 ("Already up
    // to date.") without creating a commit — landTask must reject this rather
    // than report a fake success on the unchanged base commit.
    git(["branch", "feat"], repo)
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim()

    await expect(landTask(task("feat"))).rejects.toThrow(/nothing to land/)
    // Base checkout must be untouched — no phantom merge commit.
    const after = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim()
    expect(after).toBe(head)
  })

  test("refuses a dirty base checkout", async () => {
    git(["checkout", "-b", "feat"], repo)
    write("b.txt", "feature\n")
    git(["add", "."], repo)
    git(["commit", "-m", "feat commit"], repo)
    git(["checkout", "main"], repo)
    write("dirty.txt", "uncommitted\n") // untracked → dirty

    await expect(landTask(task("feat"))).rejects.toBeInstanceOf(MainCheckoutDirtyError)
  })
})
