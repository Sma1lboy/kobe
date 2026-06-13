import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IssuesStore } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import { afterEach, describe, expect, it } from "vitest"

const cleanups: string[] = []

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "kobe-issues-store-"))
  cleanups.push(repo)
  execFileSync("git", ["init", "--quiet"], { cwd: repo })
  await writeFile(join(repo, "README.md"), "fixture\n", "utf8")
  execFileSync("git", ["add", "."], { cwd: repo })
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--quiet", "-m", "fixture"],
    {
      cwd: repo,
    },
  )
  return repo
}

afterEach(async () => {
  while (cleanups.length) {
    await rm(cleanups.pop()!, { recursive: true, force: true })
  }
})

describe("IssuesStore", () => {
  it("shares daemon issue state across git worktrees", async () => {
    const repo = await makeRepo()
    const parent = await mkdtemp(join(tmpdir(), "kobe-issues-store-wt-"))
    cleanups.push(parent)
    const worktree = join(parent, "task")
    execFileSync("git", ["worktree", "add", "--quiet", worktree, "-b", "task"], { cwd: repo })

    const storePath = join(parent, "home", ".kobe", "issues.json")
    const store = new IssuesStore(storePath)
    const canonicalRepo = await realpath(repo)

    await expect(store.list(repo)).resolves.toMatchObject({
      repoRoot: canonicalRepo,
      exists: false,
      nextId: 1,
      issues: [],
    })
    await store.mutate(repo, { type: "create", title: "Daemon issue", body: "shared state" })
    await expect(store.mutate(worktree, { type: "setStatus", id: 1, status: "done" })).resolves.toMatchObject({
      repoRoot: canonicalRepo,
      issues: [{ id: 1, status: "done" }],
    })

    await expect(store.list(repo)).resolves.toMatchObject({
      repoRoot: canonicalRepo,
      exists: true,
      nextId: 2,
      issues: [{ id: 1, title: "Daemon issue", status: "done", body: "shared state" }],
    })
    await expect(store.list(worktree)).resolves.toMatchObject({
      repoRoot: canonicalRepo,
      exists: true,
      nextId: 2,
      issues: [{ id: 1, title: "Daemon issue", status: "done", body: "shared state" }],
    })
  })

  it("migrates a stored worktree repoRoot back to the main worktree on list", async () => {
    const repo = await makeRepo()
    const parent = await mkdtemp(join(tmpdir(), "kobe-issues-store-wt-"))
    cleanups.push(parent)
    const worktree = join(parent, "task")
    execFileSync("git", ["worktree", "add", "--quiet", worktree, "-b", "task"], { cwd: repo })

    const storePath = join(parent, "home", ".kobe", "issues.json")
    const store = new IssuesStore(storePath)
    const canonicalRepo = await realpath(repo)

    await store.mutate(worktree, { type: "create", title: "From worktree" })
    const before = JSON.parse(await readFile(storePath, "utf8")) as {
      repos: Record<string, { repoRoot: string }>
    }
    expect(Object.values(before.repos)[0]?.repoRoot).toBe(canonicalRepo)

    await writeFile(
      storePath,
      `${JSON.stringify(
        {
          version: 1,
          repos: Object.fromEntries(
            Object.entries(before.repos).map(([key, value]) => [key, { ...value, repoRoot: worktree }]),
          ),
        },
        null,
        2,
      )}\n`,
      "utf8",
    )

    await expect(store.list(worktree)).resolves.toMatchObject({
      repoRoot: canonicalRepo,
      exists: true,
      issues: [{ id: 1, title: "From worktree" }],
    })

    const after = JSON.parse(await readFile(storePath, "utf8")) as {
      repos: Record<string, { repoRoot: string }>
    }
    expect(Object.values(after.repos)[0]?.repoRoot).toBe(canonicalRepo)
  })
})
