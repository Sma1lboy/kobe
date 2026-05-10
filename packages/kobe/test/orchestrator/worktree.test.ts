/**
 * Integration tests for `GitWorktreeManager` (Stream B).
 *
 * These tests intentionally use a real git binary against a real
 * fixture repo on disk — no mocking. The whole point of the worktree
 * manager is to deal with git's actual surface area: `git worktree
 * list --porcelain` formatting, dirty detection via `status
 * --porcelain`, branch lifecycle. Mocking that out would just test our
 * mock.
 *
 * Each test gets a fresh tmp repo built by
 * `test/behavior/fixtures/repo-init.sh`. We tear it down explicitly so
 * macOS's `/var/folders` doesn't fill up with stale `.claude/worktrees`
 * trees if a run is interrupted.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import { worktreePathFor, worktreeRootFor } from "../../src/orchestrator/worktree/paths.ts"

const REPO_INIT = path.resolve(__dirname, "../behavior/fixtures/repo-init.sh")

let tmpRoot: string
let repo: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-worktree-"))
  repo = path.join(tmpRoot, "repo")
  const result = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`repo-init.sh failed: ${result.stderr}\n${result.stdout}`)
  }
})

afterEach(() => {
  // Best-effort cleanup. We don't fail the test if the rm trips —
  // some platforms leave file handles momentarily after git operations.
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // ignored
  }
})

describe("GitWorktreeManager.create", () => {
  test("creates a worktree at the canonical path on a new branch", async () => {
    const mgr = new GitWorktreeManager()
    const target = worktreePathFor(repo, "task-1")

    const info = await mgr.create(repo, "kobe/task-1", target)

    expect(info.path).toBe(target)
    expect(info.branch).toBe("kobe/task-1")
    expect(info.head).toMatch(/^[0-9a-f]{40}$/)
    expect(info.dirty).toBe(false)
    expect(fs.existsSync(target)).toBe(true)
    expect(fs.existsSync(path.join(target, "README.md"))).toBe(true)
  })

  test("is idempotent: second call with the same args returns equivalent info", async () => {
    const mgr = new GitWorktreeManager()
    const target = worktreePathFor(repo, "task-1")
    const a = await mgr.create(repo, "kobe/task-1", target)
    const b = await mgr.create(repo, "kobe/task-1", target)
    expect(b.path).toBe(a.path)
    expect(b.branch).toBe(a.branch)
    expect(b.head).toBe(a.head)
  })

  test("reuses an existing branch instead of erroring", async () => {
    // Pre-create a branch on the repo (without a worktree).
    spawnSync("git", ["branch", "feature/x"], { cwd: repo })
    const mgr = new GitWorktreeManager()
    const target = worktreePathFor(repo, "task-2")
    const info = await mgr.create(repo, "feature/x", target)
    expect(info.branch).toBe("feature/x")
  })

  test("refuses to hijack an existing worktree on a different branch", async () => {
    const mgr = new GitWorktreeManager()
    const target = worktreePathFor(repo, "task-3")
    await mgr.create(repo, "kobe/task-3", target)
    await expect(mgr.create(repo, "kobe/different", target)).rejects.toThrow(/refusing to hijack/i)
  })
})

describe("GitWorktreeManager.list", () => {
  test("returns kobe-managed worktrees only", async () => {
    const mgr = new GitWorktreeManager()
    await mgr.create(repo, "kobe/a", worktreePathFor(repo, "a"))
    await mgr.create(repo, "kobe/b", worktreePathFor(repo, "b"))

    // Add a non-kobe worktree outside the .kobe root — should be filtered.
    spawnSync("git", ["worktree", "add", path.join(tmpRoot, "external"), "-b", "external"], { cwd: repo })

    const list = await mgr.list(repo)
    const branches = list.map((w) => w.branch).sort()
    expect(branches).toEqual(["kobe/a", "kobe/b"])
    for (const w of list) {
      expect(w.path.startsWith(worktreeRootFor(repo))).toBe(true)
    }
  })
})

describe("GitWorktreeManager.isDirty / currentBranch", () => {
  test("isDirty flips when a tracked file is modified", async () => {
    const mgr = new GitWorktreeManager()
    const target = worktreePathFor(repo, "task-dirty")
    await mgr.create(repo, "kobe/task-dirty", target)
    expect(await mgr.isDirty(target)).toBe(false)

    fs.appendFileSync(path.join(target, "README.md"), "\nlocal change\n")
    expect(await mgr.isDirty(target)).toBe(true)
  })

  test("isDirty flips for untracked files (caller's safety net)", async () => {
    const mgr = new GitWorktreeManager()
    const target = worktreePathFor(repo, "task-untracked")
    await mgr.create(repo, "kobe/task-untracked", target)
    expect(await mgr.isDirty(target)).toBe(false)

    fs.writeFileSync(path.join(target, "scratch.txt"), "wip\n")
    expect(await mgr.isDirty(target)).toBe(true)
  })

  test("currentBranch returns the short branch name", async () => {
    const mgr = new GitWorktreeManager()
    const target = worktreePathFor(repo, "task-branch")
    await mgr.create(repo, "kobe/task-branch", target)
    expect(await mgr.currentBranch(target)).toBe("kobe/task-branch")
  })
})

describe("GitWorktreeManager.remove", () => {
  test("removes a clean worktree without force", async () => {
    const mgr = new GitWorktreeManager()
    const target = worktreePathFor(repo, "task-rm")
    await mgr.create(repo, "kobe/task-rm", target)

    await mgr.remove(target)
    expect(fs.existsSync(target)).toBe(false)
    const list = await mgr.list(repo)
    expect(list.find((w) => w.path === target)).toBeUndefined()
  })

  test("refuses to remove a dirty worktree without force", async () => {
    const mgr = new GitWorktreeManager()
    const target = worktreePathFor(repo, "task-dirty-rm")
    await mgr.create(repo, "kobe/task-dirty-rm", target)
    fs.writeFileSync(path.join(target, "wip.txt"), "wip\n")

    await expect(mgr.remove(target)).rejects.toThrow(/dirty/i)
    // Defensive: make sure we didn't delete it anyway.
    expect(fs.existsSync(target)).toBe(true)
  })

  test("removes a dirty worktree with force=true", async () => {
    const mgr = new GitWorktreeManager()
    const target = worktreePathFor(repo, "task-force-rm")
    await mgr.create(repo, "kobe/task-force-rm", target)
    fs.writeFileSync(path.join(target, "wip.txt"), "wip\n")

    await mgr.remove(target, { force: true })
    expect(fs.existsSync(target)).toBe(false)
  })

  test("round-trip: create → remove leaves no orphan files or branch refs", async () => {
    const mgr = new GitWorktreeManager()
    const target = worktreePathFor(repo, "task-rt")
    await mgr.create(repo, "kobe/task-rt", target)
    await mgr.remove(target)

    expect(fs.existsSync(target)).toBe(false)

    // No .git/worktrees/<task-rt>/ left behind.
    const metadataDir = path.join(repo, ".git", "worktrees", "task-rt")
    expect(fs.existsSync(metadataDir)).toBe(false)

    // Worktree no longer in `git worktree list`.
    const list = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })
    expect(list.stdout).not.toContain(target)

    // The branch ref *is* preserved (per interface contract — caller
    // owns branch lifecycle). This is asserted positively: we don't
    // want a future "fix" to start deleting branches.
    const ref = spawnSync("git", ["show-ref", "--verify", "refs/heads/kobe/task-rt"], { cwd: repo })
    expect(ref.status).toBe(0)
  })
})

describe("createForTask helper", () => {
  test("computes the canonical path from taskId", async () => {
    const mgr = new GitWorktreeManager()
    const info = await mgr.createForTask({ repo, taskId: "01HABC", branch: "kobe/01HABC" })
    expect(info.path).toBe(worktreePathFor(repo, "01HABC"))
    expect(info.branch).toBe("kobe/01HABC")
  })

  test("creates the new branch rooted at the explicit baseRef", async () => {
    // Stage a non-main base branch with a distinct commit, then
    // assert that creating a new worktree with `baseRef: "side-base"`
    // descends from that commit (not from `main`).
    //
    // This is the load-bearing assertion for the new-task dialog's
    // "from branch" feature: when the user picks a non-default base
    // we must thread it all the way through to
    // `git worktree add -b <new> <path> <baseRef>`. Without that,
    // every task silently branches off whatever happens to be
    // checked out in the source repo.
    spawnSync("git", ["checkout", "-b", "side-base"], { cwd: repo })
    fs.writeFileSync(path.join(repo, "SIDE.md"), "side\n")
    spawnSync("git", ["add", "SIDE.md"], { cwd: repo })
    spawnSync("git", ["commit", "-m", "side base"], { cwd: repo })
    const sideSha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim()
    // Move HEAD back to main so `baseRef: "side-base"` actually
    // matters — without baseRef, the new worktree would inherit
    // main's HEAD instead.
    spawnSync("git", ["checkout", "main"], { cwd: repo })

    const mgr = new GitWorktreeManager()
    const info = await mgr.createForTask({
      repo,
      taskId: "from-side",
      branch: "kobe/from-side",
      baseRef: "side-base",
    })

    // Worktree's HEAD must be descended from side-base's SHA.
    const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", sideSha, "HEAD"], {
      cwd: info.path,
    })
    expect(ancestry.status).toBe(0)
    // And the side-base file must be checked out in the worktree.
    expect(fs.existsSync(path.join(info.path, "SIDE.md"))).toBe(true)
    // Branch name is the requested one (NOT side-base).
    expect(info.branch).toBe("kobe/from-side")
  })
})
