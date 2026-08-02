/**
 * A quick-fork branches off the SOURCE TASK'S worktree branch, not off the
 * main checkout's branch — the child has to carry the parent's commits.
 * Pinned against a throwaway tmpdir repo + worktree.
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { quickForkComposerOptions } from "@/tui-react/workspace/quick-fork"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

let root: string
let repo: string
let worktree: string

function git(cwd: string, ...args: string[]): void {
  const out = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf-8" })
  if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`)
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-quick-fork-test-"))
  repo = path.join(root, "repo")
  worktree = path.join(root, "wt")
  fs.mkdirSync(repo)
  git(repo, "init", "-b", "main")
  git(repo, "commit", "--allow-empty", "-m", "init")
  git(repo, "worktree", "add", "-b", "kobe/parent", worktree)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("quickForkComposerOptions", () => {
  it("seeds the base ref from the task's worktree branch", () => {
    expect(quickForkComposerOptions(repo, ["claude"], "claude", worktree).defaultBaseRef).toBe("kobe/parent")
  })

  it("falls back to the repo's branch when the worktree path is gone", () => {
    expect(quickForkComposerOptions(repo, ["claude"], "claude", path.join(root, "vanished")).defaultBaseRef).toBe(
      "main",
    )
  })
})
