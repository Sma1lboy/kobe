import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IssuesStore } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import { afterEach, describe, expect, it } from "vitest"

const cleanups: string[] = []

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "kobe-issues-store-"))
  cleanups.push(repo)
  execFileSync("git", ["init", "--quiet"], { cwd: repo })
  await mkdir(join(repo, "docs"), { recursive: true })
  await writeFile(
    join(repo, "docs", "issues.json"),
    `${JSON.stringify(
      {
        nextId: 9,
        issues: [{ id: 8, title: "喵喵", status: "doing", created: "2026-06-13", body: "喵喵叫两下" }],
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
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
  it("imports docs/issues.json once, then shares state across git worktrees", async () => {
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
      exists: true,
      nextId: 9,
      issues: [{ id: 8, title: "喵喵", status: "doing" }],
    })
    await store.mutate(worktree, { type: "setStatus", id: 8, status: "done" })

    await expect(store.list(repo)).resolves.toMatchObject({
      issues: [{ id: 8, title: "喵喵", status: "done" }],
    })
    const sourceFile = await readFile(join(repo, "docs", "issues.json"), "utf8")
    expect(JSON.parse(sourceFile).issues[0].status).toBe("doing")
  })
})
