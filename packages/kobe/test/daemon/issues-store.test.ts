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
  it("rejects plain directories with a clean non-git error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kobe-issues-store-plain-"))
    cleanups.push(dir)
    const storePath = join(dir, "home", ".kobe", "issues.json")
    const store = new IssuesStore(storePath)

    await expect(store.list(dir)).rejects.toThrow("repoRoot is not a git repository")
  })

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

  it("does not drop mutations when two different repos write concurrently", async () => {
    const repoA = await makeRepo()
    const repoB = await makeRepo()
    const parent = await mkdtemp(join(tmpdir(), "kobe-issues-store-conc-"))
    cleanups.push(parent)
    const store = new IssuesStore(join(parent, "home", ".kobe", "issues.json"))

    const N = 15
    const ops: Promise<unknown>[] = []
    for (let i = 0; i < N; i++) {
      ops.push(store.mutate(repoA, { type: "create", title: `A${i}` }))
      ops.push(store.mutate(repoB, { type: "create", title: `B${i}` }))
    }
    await Promise.all(ops)

    await expect(store.list(repoA)).resolves.toMatchObject({ exists: true, nextId: N + 1 })
    await expect(store.list(repoB)).resolves.toMatchObject({ exists: true, nextId: N + 1 })
    expect((await store.list(repoA)).issues).toHaveLength(N)
    expect((await store.list(repoB)).issues).toHaveLength(N)
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

  describe("mirrorTaskDone", () => {
    async function linkedStore(): Promise<{ repo: string; store: IssuesStore }> {
      const repo = await makeRepo()
      const home = await mkdtemp(join(tmpdir(), "kobe-issues-store-mirror-"))
      cleanups.push(home)
      const store = new IssuesStore(join(home, ".kobe", "issues.json"))
      await store.mutate(repo, { type: "create", title: "Linked" })
      await store.mutate(repo, { type: "link", id: 1, taskId: "task-abc" })
      return { repo, store }
    }

    it("flips the issue linked to a task to done and returns the new state", async () => {
      const { repo, store } = await linkedStore()
      const next = await store.mirrorTaskDone(repo, "task-abc")
      expect(next?.issues.find((i) => i.id === 1)?.status).toBe("done")
    })

    it("returns null when the linked issue is already done (no re-clobber)", async () => {
      const { repo, store } = await linkedStore()
      await store.mutate(repo, { type: "setStatus", id: 1, status: "done" })
      expect(await store.mirrorTaskDone(repo, "task-abc")).toBeNull()
    })

    it("returns null when no issue is linked to the task", async () => {
      const { repo, store } = await linkedStore()
      expect(await store.mirrorTaskDone(repo, "task-nope")).toBeNull()
    })
  })
})
