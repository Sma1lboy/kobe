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
import {
  EMPTY_BRANCH_CODE,
  EMPTY_BRANCH_DIRTY_WORKTREE_CODE,
  EmptyBranchDirtyWorktreeError,
  EmptyBranchError,
  LandConflictError,
  MainCheckoutDirtyError,
} from "../../src/orchestrator/errors.ts"
import { landTask, landTaskWithCleanup } from "../../src/orchestrator/land.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
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

  test("merge refuses a branch with no commits ahead (already merged / empty)", async () => {
    // `feat` branches off main but adds no commits of its own. Landing it
    // would be a git-level no-op — landTask must reject it as EMPTY_BRANCH
    // rather than report a fake success on the unchanged base commit.
    git(["branch", "feat"], repo)
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim()

    await expect(landTask(task("feat"))).rejects.toBeInstanceOf(EmptyBranchError)
    await expect(landTask(task("feat"))).rejects.toThrow(EMPTY_BRANCH_CODE)
    // Base checkout must be untouched — no phantom merge commit.
    const after = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim()
    expect(after).toBe(head)
  })

  test("empty branch + clean worktree → EMPTY_BRANCH (no-op, worker delivered nothing)", async () => {
    // A materialised worktree on `feat` with no commits and no local changes:
    // the worker may have reported success without delivering anything.
    const wt = path.join(tmpRoot, "wt-clean")
    git(["worktree", "add", "-b", "feat", wt], repo)
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim()

    await expect(landTask({ ...task("feat"), worktreePath: wt })).rejects.toBeInstanceOf(EmptyBranchError)
    await expect(landTask({ ...task("feat"), worktreePath: wt })).rejects.toThrow(/no-op/)
    const after = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim()
    expect(after).toBe(head)
  })

  test("empty branch + dirty worktree → EMPTY_BRANCH_DIRTY_WORKTREE listing the uncommitted files", async () => {
    // The work was WRITTEN but never committed: branch has 0 commits ahead,
    // the worktree still holds the changes. Refuse, name the files, and hint
    // at committing in the worktree — never silently drop them into a no-op.
    const wt = path.join(tmpRoot, "wt-dirty")
    git(["worktree", "add", "-b", "feat", wt], repo)
    fs.writeFileSync(path.join(wt, "wip.txt"), "uncommitted work\n")

    try {
      await landTask({ ...task("feat"), worktreePath: wt })
      expect.unreachable("landTask should refuse an empty branch with a dirty worktree")
    } catch (err) {
      expect(err).toBeInstanceOf(EmptyBranchDirtyWorktreeError)
      const msg = (err as Error).message
      expect(msg).toContain(EMPTY_BRANCH_DIRTY_WORKTREE_CODE)
      expect(msg).toContain("wip.txt")
      expect(msg).toContain(wt)
      expect(msg).toMatch(/commit them in the worktree/)
    }
    // The uncommitted file survives the refusal, and the base is untouched.
    expect(fs.existsSync(path.join(wt, "wip.txt"))).toBe(true)
    expect(fs.existsSync(path.join(repo, "wip.txt"))).toBe(false)
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

describe("landTaskWithCleanup --remove-worktree", () => {
  let wt: string

  /** Real worktree on branch `feat` with one committed file, base back on main. */
  function makeWorktree(): void {
    wt = path.join(tmpRoot, "wt")
    git(["worktree", "add", "-b", "feat", wt], repo)
    fs.writeFileSync(path.join(wt, "b.txt"), "feature\n")
    git(["add", "."], wt)
    git(["commit", "-m", "feat commit"], wt)
  }

  function deps() {
    const cleared: string[] = []
    return {
      cleared,
      deps: {
        worktrees: new GitWorktreeManager(),
        setArchived: async () => {},
        clearWorktreePath: async (id: unknown) => {
          cleared.push(String(id))
        },
      },
    }
  }

  function branchExists(name: string): boolean {
    return spawnSync("git", ["branch", "--list", name], { cwd: repo, encoding: "utf8" }).stdout.trim().length > 0
  }

  test("successful land removes the worktree, keeps the branch, unlinks the task", async () => {
    makeWorktree()
    const { deps: d, cleared } = deps()
    const res = await landTaskWithCleanup({ ...task("feat"), worktreePath: wt }, { removeWorktree: true }, d)
    expect(res.worktree).toEqual({ removed: true })
    expect(fs.existsSync(wt)).toBe(false)
    expect(branchExists("feat")).toBe(true)
    expect(cleared).toEqual(["t-land"])
    expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(true) // the merge itself landed
  })

  test("dirty worktree is refused (no force) but the land still stands", async () => {
    makeWorktree()
    fs.writeFileSync(path.join(wt, "wip.txt"), "uncommitted\n")
    const { deps: d, cleared } = deps()
    const res = await landTaskWithCleanup({ ...task("feat"), worktreePath: wt }, { removeWorktree: true }, d)
    expect(res.worktree?.removed).toBe(false)
    expect(res.worktree?.reason).toMatch(/dirty/)
    expect(fs.existsSync(path.join(wt, "wip.txt"))).toBe(true)
    expect(cleared).toEqual([])
    expect(fs.existsSync(path.join(repo, "b.txt"))).toBe(true)
  })

  test("caller inside the worktree is refused with an explanation", async () => {
    makeWorktree()
    const { deps: d } = deps()
    const res = await landTaskWithCleanup(
      { ...task("feat"), worktreePath: wt },
      { removeWorktree: true, callerCwd: wt },
      d,
    )
    expect(res.worktree?.removed).toBe(false)
    expect(res.worktree?.reason).toMatch(/caller's own worktree/)
    expect(fs.existsSync(wt)).toBe(true)
  })

  test("never removes the base checkout even if worktreePath points at it", async () => {
    makeWorktree()
    const { deps: d } = deps()
    const res = await landTaskWithCleanup({ ...task("feat"), worktreePath: repo }, { removeWorktree: true }, d)
    expect(res.worktree?.removed).toBe(false)
    expect(res.worktree?.reason).toMatch(/base checkout/)
    expect(fs.existsSync(repo)).toBe(true)
  })

  test("without removeWorktree the result has no worktree field", async () => {
    makeWorktree()
    const { deps: d } = deps()
    const res = await landTaskWithCleanup({ ...task("feat"), worktreePath: wt }, {}, d)
    expect(res.worktree).toBeUndefined()
    expect(fs.existsSync(wt)).toBe(true)
  })
})
