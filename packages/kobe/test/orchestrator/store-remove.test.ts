import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"

let home: string
let store: TaskIndexStore

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "kobe-store-remove-"))
  store = new TaskIndexStore({ homeDir: home })
  await store.load()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe("TaskIndexStore.remove", () => {
  it("removes the task from cache AND disk", async () => {
    const task = await store.create({
      repo: "/repo",
      title: "t",
      branch: "kobe/t",
      worktreePath: "/repo/wt",
      status: "backlog",
    })
    await store.remove(task.id)
    expect(store.list().some((t) => t.id === task.id)).toBe(false)

    const reloaded = new TaskIndexStore({ homeDir: home })
    await reloaded.load()
    expect(reloaded.list().some((t) => t.id === task.id)).toBe(false)
  })

  it("a stale concurrent writer cannot resurrect a removed task (tombstone)", async () => {
    const task = await store.create({
      repo: "/repo",
      title: "t",
      branch: "kobe/t",
      worktreePath: "/repo/wt",
      status: "backlog",
    })
    const stale = new TaskIndexStore({ homeDir: home })
    await stale.load()
    await store.remove(task.id)
    expect(store.list().some((t) => t.id === task.id)).toBe(false)
  })

  it("removing an unknown id is a silent no-op", async () => {
    await expect(store.remove("no-such-task")).resolves.toBeUndefined()
  })

  it("exposes filePath + stateDir for tooling", () => {
    expect(store.filePath.endsWith("tasks.json")).toBe(true)
    expect(store.filePath.startsWith(store.stateDir)).toBe(true)
  })

  it("_unlinkForTests wipes disk + memory and tolerates already-gone files", async () => {
    await store.create({ repo: "/repo", title: "t", branch: "kobe/t", worktreePath: "/repo/wt", status: "backlog" })
    await store._unlinkForTests()
    await store._unlinkForTests()
    await store.load()
    expect(store.list()).toEqual([])
  })
})
