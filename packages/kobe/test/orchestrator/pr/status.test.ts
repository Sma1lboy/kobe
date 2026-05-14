import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  detectPRProvider,
  initialPRStatus,
  refreshPRStatus,
  renderPRMergeInstructions,
} from "../../../src/orchestrator/pr/status.ts"
import type { Task } from "../../../src/types/task.ts"
import { toTaskId } from "../../../src/types/task.ts"

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

async function makeRepo(remoteUrl: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kobe-pr-status-"))
  repos.push(dir)
  git(dir, ["init", "--quiet", "--initial-branch=main"])
  git(dir, ["config", "user.email", "harness@kobe.test"])
  git(dir, ["config", "user.name", "kobe harness"])
  git(dir, ["config", "commit.gpgsign", "false"])
  await fs.writeFile(path.join(dir, "README.md"), "# fixture\n", "utf8")
  git(dir, ["add", "README.md"])
  git(dir, ["commit", "--quiet", "-m", "init"])
  git(dir, ["remote", "add", "origin", remoteUrl])
  return dir
}

async function installFakeGh(stdout: string): Promise<string> {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "kobe-fake-gh-"))
  repos.push(bin)
  const gh = path.join(bin, "gh")
  await fs.writeFile(gh, `#!/bin/sh\nprintf '%s' '${stdout.replaceAll("'", "'\\''")}'\n`, "utf8")
  await fs.chmod(gh, 0o755)
  const oldPath = process.env.PATH ?? ""
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`
  return oldPath
}

function task(worktreePath: string, prStatus?: Task["prStatus"]): Task {
  return {
    id: toTaskId("task-1"),
    title: "task",
    repo: worktreePath,
    branch: "feature",
    worktreePath,
    kind: "task",
    sessionId: null,
    tabs: [{ id: "tab-1", sessionId: null, seq: 1, createdAt: "2026-05-14T00:00:00.000Z" }],
    activeTabId: "tab-1",
    status: "in_review",
    archived: false,
    createdAt: "2026-05-14T00:00:00.000Z",
    updatedAt: "2026-05-14T00:00:00.000Z",
    ...(prStatus ? { prStatus } : {}),
  }
}

let repos: string[] = []

afterEach(async () => {
  for (const repo of repos) await fs.rm(repo, { recursive: true, force: true }).catch(() => {})
  repos = []
})

describe("PR status", () => {
  test("detects GitHub provider and seeds creating status", async () => {
    const repo = await makeRepo("git@github.com:sma1lboy/kobe.git")
    expect(detectPRProvider(repo)).toBe("github")
    expect(initialPRStatus(repo)).toMatchObject({ provider: "github", lifecycle: "creating", checkState: "unknown" })
  })

  test("non-GitHub providers fall back to no visible CI status", async () => {
    const repo = await makeRepo("git@gitlab.com:example/project.git")
    expect(detectPRProvider(repo)).toBe("gitlab")
    expect(initialPRStatus(repo)).toBeUndefined()
    expect(await refreshPRStatus(task(repo))).toBeUndefined()
  })

  test("normalizes passing GitHub checks into ready_to_merge", async () => {
    const repo = await makeRepo("https://github.com/sma1lboy/kobe.git")
    const oldPath = await installFakeGh(
      JSON.stringify({
        number: 132,
        url: "https://github.com/sma1lboy/kobe/pull/132",
        title: "Track PR status",
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        baseRefName: "main",
        headRefName: "feature",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
    )
    try {
      expect(await refreshPRStatus(task(repo))).toMatchObject({
        provider: "github",
        lifecycle: "ready_to_merge",
        checkState: "passing",
        number: 132,
      })
    } finally {
      process.env.PATH = oldPath
    }
  })

  test("normalizes failing checks into open PR status", async () => {
    const repo = await makeRepo("https://github.com/sma1lboy/kobe.git")
    const oldPath = await installFakeGh(
      JSON.stringify({
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
      }),
    )
    try {
      expect(await refreshPRStatus(task(repo))).toMatchObject({
        provider: "github",
        lifecycle: "open",
        checkState: "failing",
      })
    } finally {
      process.env.PATH = oldPath
    }
  })

  test("merge prompt asks the agent to verify GitHub status before merging", () => {
    const prompt = renderPRMergeInstructions({
      provider: "github",
      lifecycle: "ready_to_merge",
      checkState: "passing",
      number: 132,
      url: "https://github.com/sma1lboy/kobe/pull/132",
    })
    expect(prompt).toContain("clicked Merge")
    expect(prompt).toContain("Re-check the PR status")
    expect(prompt).toContain("gh pr merge")
  })
})
