import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import {
  LEGACY_KOBE_WORKTREE_ROOT_SUBPATH,
  REPO_LOCAL_KOBE_WORKTREE_ROOT_SUBPATH,
  worktreePathFor,
  worktreeRootFor,
} from "../../src/orchestrator/worktree/paths.ts"

const REPO_INIT = path.resolve(__dirname, "./fixtures/repo-init.sh")

let tmpRoot: string
let repo: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env.KOBE_HOME_DIR
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-worktree-"))
  process.env.KOBE_HOME_DIR = path.join(tmpRoot, "home")
  repo = path.join(tmpRoot, "repo")
  const result = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`repo-init.sh failed: ${result.stderr}\n${result.stdout}`)
  }
})

afterEach(() => {
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = prevHome
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {}
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
    expect(target.startsWith(path.join(tmpRoot, "home", ".kobe", "worktrees"))).toBe(true)
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

    spawnSync("git", ["worktree", "add", path.join(tmpRoot, "external"), "-b", "external"], { cwd: repo })

    const list = await mgr.list(repo)
    const branches = list.map((w) => w.branch).sort()
    expect(branches).toEqual(["kobe/a", "kobe/b"])
    for (const w of list) {
      expect(w.path.startsWith(worktreeRootFor(repo))).toBe(true)
    }
  })

  test("still lists legacy .claude/worktrees tasks without rewriting their paths", async () => {
    const mgr = new GitWorktreeManager()
    const legacyTarget = path.join(repo, LEGACY_KOBE_WORKTREE_ROOT_SUBPATH, "legacy")
    await mgr.create(repo, "kobe/legacy", legacyTarget)

    const list = await mgr.list(repo)
    expect(list.find((w) => w.branch === "kobe/legacy")?.path).toBe(legacyTarget)
  })

  test("still lists repo-local .kobe/worktrees tasks without rewriting their paths", async () => {
    const mgr = new GitWorktreeManager()
    const localTarget = path.join(repo, REPO_LOCAL_KOBE_WORKTREE_ROOT_SUBPATH, "local")
    await mgr.create(repo, "kobe/local", localTarget)

    const list = await mgr.list(repo)
    expect(list.find((w) => w.branch === "kobe/local")?.path).toBe(localTarget)
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

    const metadataDir = path.join(repo, ".git", "worktrees", "task-rt")
    expect(fs.existsSync(metadataDir)).toBe(false)

    const list = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })
    expect(list.stdout).not.toContain(target)

    const ref = spawnSync("git", ["show-ref", "--verify", "refs/heads/kobe/task-rt"], { cwd: repo })
    expect(ref.status).toBe(0)
  })
})

describe("createForTask helper", () => {
  test("computes the canonical path from slug", async () => {
    const mgr = new GitWorktreeManager()
    const info = await mgr.createForTask({ repo, slug: "panda", branch: "kobe/panda" })
    expect(info.path).toBe(worktreePathFor(repo, "panda"))
    expect(info.branch).toBe("kobe/panda")
  })

  test("creates the new branch rooted at the explicit baseRef", async () => {
    spawnSync("git", ["checkout", "-b", "side-base"], { cwd: repo })
    fs.writeFileSync(path.join(repo, "SIDE.md"), "side\n")
    spawnSync("git", ["add", "SIDE.md"], { cwd: repo })
    spawnSync("git", ["commit", "-m", "side base"], { cwd: repo })
    const sideSha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim()
    spawnSync("git", ["checkout", "main"], { cwd: repo })

    const mgr = new GitWorktreeManager()
    const info = await mgr.createForTask({
      repo,
      slug: "from-side",
      branch: "kobe/from-side",
      baseRef: "side-base",
    })

    const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", sideSha, "HEAD"], {
      cwd: info.path,
    })
    expect(ancestry.status).toBe(0)
    expect(fs.existsSync(path.join(info.path, "SIDE.md"))).toBe(true)
    expect(info.branch).toBe("kobe/from-side")
  })
})

describe("GitWorktreeManager.listAll (KOB-256)", () => {
  test("includes external worktrees + excludes main checkout, with kobeManaged flags", async () => {
    const mgr = new GitWorktreeManager()
    const managed = await mgr.createForTask({ repo, slug: "managed-wt", branch: "kobe/managed" })
    const extPath = path.join(tmpRoot, "external-wt")
    const r = spawnSync("git", ["worktree", "add", "-b", "ext-branch", extPath], { cwd: repo, encoding: "utf8" })
    expect(r.status).toBe(0)

    const all = await mgr.listAll(repo)
    const byBranch = new Map(all.map((w) => [w.branch, w]))

    expect(byBranch.has("kobe/managed")).toBe(true)
    expect(byBranch.has("ext-branch")).toBe(true)
    for (const w of all) expect(fs.realpathSync(w.path)).not.toBe(fs.realpathSync(repo))
    expect(byBranch.get("kobe/managed")?.kobeManaged).toBe(true)
    expect(byBranch.get("ext-branch")?.kobeManaged).toBe(false)
    const managedOnly = await mgr.list(repo)
    expect(managedOnly.some((w) => w.branch === "kobe/managed")).toBe(true)
    expect(managedOnly.some((w) => w.branch === "ext-branch")).toBe(false)
    void managed
  })
})
