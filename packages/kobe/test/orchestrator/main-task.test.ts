import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import { addSavedRepo, getSavedRepos } from "../../src/state/repos.ts"

const REPO_INIT = path.resolve(__dirname, "./fixtures/repo-init.sh")

let tmpRoot: string
let repo: string
let orch: Orchestrator
let originalHome: string | undefined

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-main-task-"))
  repo = path.join(tmpRoot, "repo")
  const r = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`repo-init.sh failed: ${r.stderr}\n${r.stdout}`)
  // Isolate the shared state.json (savedRepos) that forgetProject mutates so
  // tests never touch the developer's real ~/.config/kobe.
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = path.join(tmpRoot, "home")
  const store = new TaskIndexStore({ homeDir: path.join(tmpRoot, "home") })
  await store.load()
  orch = new Orchestrator({ store, worktrees: new GitWorktreeManager() })
})

afterEach(() => {
  // biome-ignore lint/performance/noDelete: env cleanup must fully unset when the var was unset before the test (assigning undefined leaves the string "undefined").
  if (originalHome === undefined) delete process.env.KOBE_HOME_DIR
  else process.env.KOBE_HOME_DIR = originalHome
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // ignored
  }
})

describe("ensureMainTask", () => {
  test("createTask auto-creates the repo's main row (the sidebar PROJECTS entry)", async () => {
    // Regression: `kobe add` / the new-task dialog on a brand-new repo used
    // to create only the task — no `kind:"main"` row, so the sidebar never
    // grew a PROJECTS entry for the repo (the tmux-era boot provisioned
    // mains; the daemon world must do it on every creation path).
    const task = await orch.createTask({ repo, title: "t" })
    const mains = orch.listTasks().filter((t) => t.kind === "main")
    expect(task.kind).toBe("task")
    expect(mains).toHaveLength(1)
    expect(mains[0]?.repo).toBe(repo)
    // Idempotent: a second create in the same repo adds no second main.
    await orch.createTask({ repo, title: "t2" })
    expect(orch.listTasks().filter((t) => t.kind === "main")).toHaveLength(1)
  })

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

describe("forgetProject", () => {
  test("un-saves the repo and drops its main row, keeping child tasks", async () => {
    addSavedRepo(repo)
    await orch.ensureMainTask(repo)
    const child = await orch.createTask({ repo, title: "work", vendor: "claude" })
    expect(getSavedRepos()).toContain(repo)
    expect(orch.listTasks().filter((t) => t.kind === "main")).toHaveLength(1)

    await orch.forgetProject(repo)

    expect(getSavedRepos()).not.toContain(repo)
    expect(orch.listTasks().filter((t) => t.kind === "main")).toHaveLength(0)
    // The repo dir and the real task under it survive — forget is non-destructive.
    expect(orch.getTask(child.id)?.id).toBe(child.id)
    expect(fs.existsSync(repo)).toBe(true)
  })

  test("matches a subdirectory input the same way addSavedRepo normalized it", async () => {
    const subdir = path.join(repo, "packages", "x")
    fs.mkdirSync(subdir, { recursive: true })
    addSavedRepo(repo)
    await orch.ensureMainTask(repo)

    await orch.forgetProject(subdir)

    expect(getSavedRepos()).not.toContain(repo)
    expect(orch.listTasks().filter((t) => t.kind === "main")).toHaveLength(0)
  })

  test("idempotent: forgetting a never-saved repo no-ops", async () => {
    await expect(orch.forgetProject(repo)).resolves.toBeUndefined()
    expect(orch.listTasks().filter((t) => t.kind === "main")).toHaveLength(0)
  })
})
