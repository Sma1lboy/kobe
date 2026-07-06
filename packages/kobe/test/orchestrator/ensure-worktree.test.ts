import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"

const REPO_INIT = path.resolve(__dirname, "./fixtures/repo-init.sh")

class FlakyStore extends TaskIndexStore {
  failNextUpdate = false
  deleteAfterNextUpdate = false

  override async update(id: string, patch: Partial<Parameters<TaskIndexStore["update"]>[1]>) {
    if (this.failNextUpdate) {
      this.failNextUpdate = false
      throw new Error("simulated store write failure")
    }
    const result = await super.update(id, patch as never)
    if (this.deleteAfterNextUpdate) {
      this.deleteAfterNextUpdate = false
      await super.remove(id)
    }
    return result
  }
}

let tmpRoot: string
let repo: string
let prevHome: string | undefined
let store: FlakyStore
let orch: Orchestrator

beforeEach(async () => {
  prevHome = process.env.KOBE_HOME_DIR
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-ensure-wt-"))
  const home = path.join(tmpRoot, "home")
  process.env.KOBE_HOME_DIR = home
  repo = path.join(tmpRoot, "repo")
  const r = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`repo-init.sh failed: ${r.stderr}\n${r.stdout}`)
  store = new FlakyStore({ homeDir: home })
  await store.load()
  orch = new Orchestrator({ store, worktrees: new GitWorktreeManager() })
})

afterEach(() => {
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = prevHome
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {}
})

describe("ensureWorktree — happy path", () => {
  test("creates + records the worktree, idempotent on a second call", async () => {
    const task = await orch.createTask({ repo })
    const p = await orch.ensureWorktree(task.id)
    expect(p).toBeTruthy()
    expect(fs.existsSync(p)).toBe(true)
    expect(orch.getTask(task.id)?.worktreePath).toBe(p)

    expect(await orch.ensureWorktree(task.id)).toBe(p)
    expect((await new GitWorktreeManager().list(repo)).length).toBe(1)
  })

  test("concurrent calls dedupe to one worktree + the same path", async () => {
    const task = await orch.createTask({ repo })
    const [a, b] = await Promise.all([orch.ensureWorktree(task.id), orch.ensureWorktree(task.id)])
    expect(a).toBe(b)
    expect((await new GitWorktreeManager().list(repo)).length).toBe(1)
  })
})

describe("ensureWorktree — partial-failure cleanup (no orphans)", () => {
  test("a failed worktreePath write rolls back the just-created worktree + frees the slug", async () => {
    const task = await orch.createTask({ repo })
    store.failNextUpdate = true

    await expect(orch.ensureWorktree(task.id)).rejects.toThrow(/simulated store write failure/)

    expect(orch.getTask(task.id)?.worktreePath).toBe("")
    expect(await new GitWorktreeManager().list(repo)).toEqual([])
  })

  test("retry after a failed write succeeds cleanly (operation is idempotent/retryable)", async () => {
    const task = await orch.createTask({ repo })
    store.failNextUpdate = true
    await expect(orch.ensureWorktree(task.id)).rejects.toThrow()

    const p = await orch.ensureWorktree(task.id)
    expect(fs.existsSync(p)).toBe(true)
    expect(orch.getTask(task.id)?.worktreePath).toBe(p)
    const list = await new GitWorktreeManager().list(repo)
    expect(list.length).toBe(1)
    expect(list[0]?.path).toBe(p)
  })
})

describe("ensureWorktree — concurrent delete after a successful write", () => {
  test("returns the created path instead of throwing TaskNotFound", async () => {
    const task = await orch.createTask({ repo })
    store.deleteAfterNextUpdate = true

    const p = await orch.ensureWorktree(task.id)
    expect(p).toBeTruthy()
    expect(fs.existsSync(p)).toBe(true)
    expect(orch.getTask(task.id)).toBeUndefined()
  })
})
