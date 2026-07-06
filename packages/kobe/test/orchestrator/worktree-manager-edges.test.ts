import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"

let root: string
let repo: string
let manager: GitWorktreeManager

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kobe-wtm-edge-")))
  repo = join(root, "repo")
  mkdirSync(repo)
  execSync("git init -q -b main && git commit -q --allow-empty -m init", { cwd: repo, env: gitEnv })
  manager = new GitWorktreeManager()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("create() conflicts", () => {
  it("refuses a target dir that exists but is not a registered worktree", async () => {
    const stale = join(root, "stale-dir")
    mkdirSync(stale)
    writeFileSync(join(stale, "user-file.txt"), "precious")
    await expect(manager.create(repo, "kobe/stale", stale)).rejects.toThrow(
      /exists but is not a registered git worktree/,
    )
    expect(() => execSync(`ls ${JSON.stringify(join(stale, "user-file.txt"))}`)).not.toThrow()
  })

  it("rejects relative paths outright", async () => {
    await expect(manager.create("relative/repo", "b", join(root, "x"))).rejects.toThrow(/absolute path/)
    await expect(manager.create(repo, "b", "relative/wt")).rejects.toThrow(/absolute path/)
  })
})

describe("remove() / currentBranch() edges", () => {
  it("remove() on a directory that is not a worktree surfaces the fact", async () => {
    const plain = join(root, "plain-dir")
    mkdirSync(plain)
    await expect(manager.remove(plain)).rejects.toThrow(/is not a git worktree/)
  })

  it("remove() of an already-deleted worktree dir resolves quietly (best-effort prune)", async () => {
    const wt = join(root, "wt-gone")
    await manager.create(repo, "kobe/gone", wt)
    rmSync(wt, { recursive: true, force: true })
    await expect(manager.remove(wt)).resolves.toBeUndefined()
  })

  it("currentBranch() rejects a detached-HEAD worktree explicitly", async () => {
    const wt = join(root, "wt-detached")
    await manager.create(repo, "kobe/detach-me", wt)
    execSync("git checkout -q --detach", { cwd: wt, env: gitEnv })
    await expect(manager.currentBranch(wt)).rejects.toThrow(/detached-HEAD/)
  })
})
