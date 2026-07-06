import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"

const REPO_INIT = path.resolve(__dirname, "./fixtures/repo-init.sh")

let tmpRoot: string
let repo: string
let orch: Orchestrator

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-adopt-"))
  repo = path.join(tmpRoot, "repo")
  const r = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`repo-init.sh failed: ${r.stderr}\n${r.stdout}`)
  const store = new TaskIndexStore({ homeDir: path.join(tmpRoot, "home") })
  await store.load()
  orch = new Orchestrator({ store, worktrees: new GitWorktreeManager() })
})

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {}
})

function addExternalWorktree(branch: string): string {
  const p = path.join(tmpRoot, `ext-${branch}`)
  const r = spawnSync("git", ["worktree", "add", "-b", branch, p], { cwd: repo, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git worktree add failed: ${r.stderr}`)
  return p
}

describe("discoverAdoptableWorktrees", () => {
  test("lists external worktrees not yet linked to a task", async () => {
    const ext = addExternalWorktree("featA")
    const found = await orch.discoverAdoptableWorktrees(repo)
    const branches = found.map((w) => w.branch)
    expect(branches).toContain("featA")
    expect(found.find((w) => w.branch === "featA")?.kobeManaged).toBe(false)
    void ext
  })

  test("excludes worktrees already adopted as tasks", async () => {
    const ext = addExternalWorktree("featB")
    await orch.adoptWorktree({ repo, worktreePath: ext, branch: "featB" })
    const found = await orch.discoverAdoptableWorktrees(repo)
    expect(found.map((w) => w.branch)).not.toContain("featB")
  })
})

describe("adoptWorktree", () => {
  test("creates a task pointing at the existing worktree, no fs allocation", async () => {
    const ext = addExternalWorktree("featC")
    const task = await orch.adoptWorktree({ repo, worktreePath: ext, branch: "featC", title: "my-feat" })
    expect(task.kind).toBe("task")
    expect(task.branch).toBe("featC")
    expect(task.title).toBe("my-feat")
    expect(fs.realpathSync(task.worktreePath)).toBe(fs.realpathSync(ext))
    expect(await orch.ensureWorktree(task.id)).toBe(task.worktreePath)
  })

  test("defaults the title to the worktree directory basename", async () => {
    const ext = addExternalWorktree("featD")
    const task = await orch.adoptWorktree({ repo, worktreePath: ext, branch: "featD" })
    expect(task.title).toBe(path.basename(ext))
  })

  test("rejects a path that isn't an adoptable worktree of the repo", async () => {
    await expect(orch.adoptWorktree({ repo, worktreePath: path.join(tmpRoot, "nope"), branch: "x" })).rejects.toThrow()
  })

  test("rejects adopting the same worktree twice", async () => {
    const ext = addExternalWorktree("featE")
    await orch.adoptWorktree({ repo, worktreePath: ext, branch: "featE" })
    await expect(orch.adoptWorktree({ repo, worktreePath: ext, branch: "featE" })).rejects.toThrow(/already adopted/)
  })
})
