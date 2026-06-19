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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-main-task-"))
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
  } catch {
    // ignored
  }
})

describe("ensureMainTask", () => {
  test("dedupes repo-root and subdirectory inputs to one main task", async () => {
    const subdir = path.join(repo, "packages", "kobe")
    fs.mkdirSync(subdir, { recursive: true })

    const first = await orch.ensureMainTask(repo)
    const second = await orch.ensureMainTask(subdir)
    const mainRows = orch.listTasks().filter((t) => t.kind === "main")

    expect(second.id).toBe(first.id)
    expect(mainRows).toHaveLength(1)
    expect(mainRows[0]?.repo).toBe(first.repo)
  })

  test("dedupes concurrent equivalent repo inputs before either create settles", async () => {
    const subdir = path.join(repo, "src")
    fs.mkdirSync(subdir)

    const [first, second] = await Promise.all([orch.ensureMainTask(repo), orch.ensureMainTask(subdir)])

    expect(second.id).toBe(first.id)
    expect(orch.listTasks().filter((t) => t.kind === "main")).toHaveLength(1)
  })
})
