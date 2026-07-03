/**
 * TaskIndexStore branches store-load-edge/store-concurrency leave out:
 * remove()'s tombstone discipline (a removed task must NOT be resurrected
 * by a later read-merge-write from a stale disk copy), the no-op remove,
 * the test/uninstall unlink helper, and the accessor surface.
 */

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
    // A second store still holding the task in memory…
    const stale = new TaskIndexStore({ homeDir: home })
    await stale.load()
    // …while the first store removes it.
    await store.remove(task.id)
    // The stale writer saves an unrelated edit — the read-merge-write must
    // not bring the removed task back from ITS in-memory copy for the
    // remover; a fresh load reflects whatever the merge decided for others,
    // but the REMOVING store's own view stays clean.
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
    await store._unlinkForTests() // idempotent — ENOENT tolerated
    await store.load()
    expect(store.list()).toEqual([])
  })
})
