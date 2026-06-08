/**
 * Branch-follows-title (KOB). When a task's branch is still the
 * placeholder-derived default (`kobe/new-task-<id>`), renaming the title
 * — including the auto-name from the first prompt — renames the real git
 * branch in lockstep. A manually-set branch, or a branch derived from a
 * non-placeholder title, is never clobbered. Real git + real store on
 * disk; mirrors the harness in `adopt.test.ts` / `worktree.test.ts`.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { autoBranch } from "../../src/orchestrator/title.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"

const REPO_INIT = path.resolve(__dirname, "./fixtures/repo-init.sh")

let tmpRoot: string
let repo: string
let orch: Orchestrator
let prevHome: string | undefined

beforeEach(async () => {
  prevHome = process.env.KOBE_HOME_DIR
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-branchfollow-"))
  process.env.KOBE_HOME_DIR = path.join(tmpRoot, "home")
  repo = path.join(tmpRoot, "repo")
  const r = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`repo-init.sh failed: ${r.stderr}\n${r.stdout}`)
  const store = new TaskIndexStore({ homeDir: process.env.KOBE_HOME_DIR })
  await store.load()
  orch = new Orchestrator({ store, worktrees: new GitWorktreeManager() })
})

afterEach(() => {
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = prevHome
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // ignored
  }
})

/** Local branch names in the fixture repo. */
function gitBranches(): string[] {
  const r = spawnSync("git", ["branch", "--format=%(refname:short)"], { cwd: repo, encoding: "utf8" })
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
}

describe("branch follows title", () => {
  test("renames the placeholder-derived branch when the title is set", async () => {
    const task = await orch.createTask({ repo })
    await orch.ensureWorktree(task.id)

    const placeholderBranch = autoBranch("(new task)", task.id)
    expect(orch.getTask(task.id)?.branch).toBe(placeholderBranch)
    expect(gitBranches()).toContain(placeholderBranch)

    await orch.setTitle(task.id, "Fix login flow")

    const expected = autoBranch("Fix login flow", task.id)
    expect(expected).not.toBe(placeholderBranch)
    expect(orch.getTask(task.id)?.branch).toBe(expected)
    // The real git branch moved, not just the recorded name.
    expect(gitBranches()).toContain(expected)
    expect(gitBranches()).not.toContain(placeholderBranch)
  })

  test("does not touch a manually-set branch", async () => {
    const task = await orch.createTask({ repo })
    await orch.ensureWorktree(task.id)
    await orch.setBranch(task.id, "feature/custom")
    expect(gitBranches()).toContain("feature/custom")

    await orch.setTitle(task.id, "Some new title")

    // Branch was no longer the placeholder default, so it stays put.
    expect(orch.getTask(task.id)?.branch).toBe("feature/custom")
    expect(gitBranches()).toContain("feature/custom")
  })

  test("only follows once — a second rename leaves the branch alone", async () => {
    const task = await orch.createTask({ repo })
    await orch.ensureWorktree(task.id)

    await orch.setTitle(task.id, "First name")
    const afterFirst = autoBranch("First name", task.id)
    expect(orch.getTask(task.id)?.branch).toBe(afterFirst)

    await orch.setTitle(task.id, "Second name")
    // Branch is no longer the placeholder default, so the second rename
    // does not move it — it tracks the first non-placeholder title.
    expect(orch.getTask(task.id)?.branch).toBe(afterFirst)
    expect(gitBranches()).toContain(afterFirst)
  })

  test("a not-yet-materialised task derives its branch from the new title on ensureWorktree", async () => {
    const task = await orch.createTask({ repo })
    // No worktree yet: setTitle records the title, the branch stays empty.
    await orch.setTitle(task.id, "Pre-materialise name")
    expect(orch.getTask(task.id)?.branch).toBe("")

    await orch.ensureWorktree(task.id)
    expect(orch.getTask(task.id)?.branch).toBe(autoBranch("Pre-materialise name", task.id))
  })
})
