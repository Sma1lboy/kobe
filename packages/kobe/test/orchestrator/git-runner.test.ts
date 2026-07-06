import { execSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { GitCommandError, git } from "../../src/orchestrator/worktree/git.ts"

let repo: string

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "kobe-git-runner-")))
  execSync("git init -q -b main", { cwd: repo })
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe("git()", () => {
  test("runs in the given cwd and returns stdout", () => {
    const result = git(["rev-parse", "--show-toplevel"], { cwd: repo })
    expect(result.exitCode).toBe(0)
    expect(realpathSync(result.stdout.trim())).toBe(repo)
  })

  test("refuses to run without an explicit cwd", () => {
    expect(() => git(["status"], { cwd: "" })).toThrow("cwd is required")
  })

  test("merges extra env over process.env", () => {
    git(["commit", "--allow-empty", "-m", "probe"], {
      cwd: repo,
      env: {
        GIT_AUTHOR_NAME: "Env Probe",
        GIT_AUTHOR_EMAIL: "probe@test",
        GIT_COMMITTER_NAME: "Env Probe",
        GIT_COMMITTER_EMAIL: "probe@test",
      },
    })
    const who = git(["log", "-1", "--format=%an"], { cwd: repo })
    expect(who.stdout.trim()).toBe("Env Probe")
  })

  test("throws GitCommandError with the full diagnostic payload on failure", () => {
    let caught: GitCommandError | undefined
    try {
      git(["rev-parse", "--verify", "no-such-ref-xyz"], { cwd: repo })
    } catch (err) {
      caught = err as GitCommandError
    }
    expect(caught).toBeInstanceOf(GitCommandError)
    expect(caught?.name).toBe("GitCommandError")
    expect(caught?.args).toEqual(["rev-parse", "--verify", "no-such-ref-xyz"])
    expect(caught?.cwd).toBe(repo)
    expect(caught?.exitCode).not.toBe(0)
    expect(caught?.message).toContain("rev-parse --verify no-such-ref-xyz")
    expect(caught?.message).toContain(`cwd=${repo}`)
  })

  test("allowFail suppresses the throw and hands back the non-zero result", () => {
    const result = git(["rev-parse", "--verify", "no-such-ref-xyz"], { cwd: repo, allowFail: true })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})
