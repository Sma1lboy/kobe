import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type DaemonHandlerContext,
  createDaemonHandlerRegistry,
  dispatchDaemonRequest,
} from "@sma1lboy/kobe-daemon/daemon/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { addSavedRepo } from "../../src/state/repos.ts"

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
}

const FAKE_CTX = {} as DaemonHandlerContext

function dispatch(name: string, payload: unknown): Promise<unknown> {
  return dispatchDaemonRequest(createDaemonHandlerRegistry(), name, payload, FAKE_CTX)
}

let root: string
let repo: string
let prevHome: string | undefined

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kobe-wt-list-")))
  prevHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = root
  repo = join(root, "repo")
  mkdirSync(repo)
  execSync("git init -q -b main && git commit -q --allow-empty -m init", { cwd: repo, env: gitEnv })
  addSavedRepo(repo)
})

afterEach(() => {
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = prevHome
  rmSync(root, { recursive: true, force: true })
})

describe("worktree.list", () => {
  it("lists a saved repo's worktrees with kobeManaged/dirty/createdAtMs/branchOnRemote", async () => {
    const wt = join(root, "adhoc-worktree")
    execSync(`git worktree add -b feature/demo ${JSON.stringify(wt)}`, { cwd: repo, env: gitEnv })

    const result = (await dispatch("worktree.list", {})) as {
      projects: Array<{ repo: string; worktrees: Array<Record<string, unknown>> }>
    }

    const project = result.projects.find((p) => p.repo === repo)
    expect(project).toBeDefined()
    expect(project?.worktrees).toHaveLength(1)
    const row = project?.worktrees[0]
    expect(row?.branch).toBe("feature/demo")
    expect(row?.kobeManaged).toBe(false)
    expect(row?.dirty).toBe(false)
    expect(typeof row?.createdAtMs).toBe("number")
    expect(row?.createdAtMs as number).toBeGreaterThan(0)
    expect(row?.branchOnRemote).toBeNull()
  })

  it("excludes repos with no worktrees from an empty result, not an error", async () => {
    const result = (await dispatch("worktree.list", {})) as { projects: Array<{ repo: string }> }
    const project = result.projects.find((p) => p.repo === repo)
    expect(project).toBeDefined()
  })
})

describe("worktree.remove", () => {
  it("removes a clean worktree without force", async () => {
    const wt = join(root, "clean-worktree")
    execSync(`git worktree add -b feature/clean ${JSON.stringify(wt)}`, { cwd: repo, env: gitEnv })

    await expect(dispatch("worktree.remove", { path: wt })).resolves.toEqual({ removed: true })
    expect(() => execSync("git worktree list", { cwd: repo, env: gitEnv }).toString()).not.toThrow()
    expect(execSync("git worktree list", { cwd: repo, env: gitEnv }).toString()).not.toContain(wt)
  })

  it("refuses a dirty worktree, then removes it once force is set — the same gate as GitWorktreeManager.remove", async () => {
    const wt = join(root, "dirty-worktree")
    execSync(`git worktree add -b feature/dirty ${JSON.stringify(wt)}`, { cwd: repo, env: gitEnv })
    writeFileSync(join(wt, "untracked.txt"), "uncommitted")

    await expect(dispatch("worktree.remove", { path: wt })).rejects.toThrow(/refusing to remove dirty worktree/)
    await expect(dispatch("worktree.remove", { path: wt, force: true })).resolves.toEqual({ removed: true })
  })

  it("rejects a missing path", async () => {
    await expect(dispatch("worktree.remove", {})).rejects.toThrow("path is required")
  })
})
