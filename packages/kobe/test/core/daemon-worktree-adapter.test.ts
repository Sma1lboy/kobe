import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { handleWorktreesRequestAdapter, listWorktreeProjectsAdapter } from "../../src/core/daemon-worktree-adapter.ts"
import { addSavedRepo } from "../../src/state/repos.ts"

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Kobe Test",
      GIT_AUTHOR_EMAIL: "kobe@example.com",
      GIT_COMMITTER_NAME: "Kobe Test",
      GIT_COMMITTER_EMAIL: "kobe@example.com",
    },
  })

describe("daemon worktree adapter", () => {
  let root: string
  let repo: string
  let worktree: string
  let previousHome: string | undefined

  beforeAll(async () => {
    previousHome = process.env.KOBE_HOME_DIR
    root = await mkdtemp(join(tmpdir(), "kobe-daemon-worktrees-"))
    process.env.KOBE_HOME_DIR = join(root, "home")
    repo = join(root, "repo")
    worktree = join(root, "feature")
    await mkdir(repo)
    await writeFile(join(repo, "README.md"), "fixture\n")
    git(repo, "init", "-b", "main")
    git(repo, "add", "README.md")
    git(repo, "commit", "-m", "fixture")
    git(repo, "worktree", "add", "-b", "feature/demo", worktree)
    addSavedRepo(repo)
  })

  afterAll(async () => {
    if (previousHome === undefined) process.env.KOBE_HOME_DIR = undefined
    else process.env.KOBE_HOME_DIR = previousHome
    await rm(root, { recursive: true, force: true })
  })

  it("lists saved local projects with worktree audit metadata", async () => {
    const projects = await listWorktreeProjectsAdapter(false)
    expect(projects).toHaveLength(1)
    expect(projects[0]?.repo).toBe(repo)
    const row = projects[0]?.worktrees.find((entry) => entry.branch === "feature/demo")
    expect(row).toEqual(expect.objectContaining({ branch: "feature/demo", repo }))
    expect(row?.path.endsWith("/feature")).toBe(true)
  })

  it("owns the HTTP route while delegating its audit policy", async () => {
    const response = await handleWorktreesRequestAdapter(
      new Request("http://localhost/api/worktrees"),
      new URL("http://localhost/api/worktrees"),
    )
    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual(expect.objectContaining({ projects: expect.any(Array) }))

    await expect(
      handleWorktreesRequestAdapter(
        new Request("http://localhost/api/worktrees", { method: "POST" }),
        new URL("http://localhost/api/worktrees"),
      ),
    ).resolves.toEqual(expect.objectContaining({ status: 405 }))
  })

  it("validates removals and turns audit failures into HTTP errors", async () => {
    const url = new URL("http://localhost/api/worktrees")
    const missingPath = await handleWorktreesRequestAdapter(
      new Request(url, { method: "DELETE", body: JSON.stringify({}) }),
      url,
    )
    expect(missingPath?.status).toBe(400)

    const removed = await handleWorktreesRequestAdapter(
      new Request(url, { method: "DELETE", body: JSON.stringify({ path: worktree }) }),
      url,
    )
    expect(removed?.status).toBe(200)
    const malformed = await handleWorktreesRequestAdapter(new Request(url, { method: "DELETE", body: "not-json" }), url)
    expect(malformed?.status).toBe(400)

    addSavedRepo(join(root, "missing"))
    const failedAudit = await handleWorktreesRequestAdapter(new Request(url), url)
    expect(failedAudit?.status).toBe(500)
  })
})
