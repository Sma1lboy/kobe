/**
 * Standalone `kind:"dir"` tasks (`kobe .`).
 *
 * Why these matter: a dir task pins the USER'S OWN directory as its
 * worktreePath. Every guarantee here is a data-loss guard — deletion must
 * only ever drop the index entry (never `git worktree remove` the user's
 * directory), no project/main task may be minted as a side effect, and
 * every open is a NEW task (parallel sessions in one directory) with a
 * randomly-suffixed title so the rows stay distinguishable.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import type { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"

let home: string
let dir: string
let store: TaskIndexStore
let orch: Orchestrator
let worktrees: {
  isDirty: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  pathExists: ReturnType<typeof vi.fn>
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kobe-dir-task-"))
  dir = await mkdtemp(join(tmpdir(), "kobe-user-dir-"))
  store = new TaskIndexStore({ homeDir: home })
  await store.load()
  worktrees = {
    isDirty: vi.fn(async () => true),
    remove: vi.fn(async () => {}),
    pathExists: vi.fn(async () => true),
  }
  orch = new Orchestrator({ store, worktrees: worktrees as unknown as GitWorktreeManager })
})

afterEach(async () => {
  orch.dispose()
  await rm(home, { recursive: true, force: true })
  await rm(dir, { recursive: true, force: true })
})

describe("openDirectoryTask", () => {
  it("creates a project-less dir task pinned to the directory", async () => {
    const task = await orch.openDirectoryTask({ dir })
    expect(task.kind).toBe("dir")
    expect(task.worktreePath).toBe(task.repo)
    expect(task.branch).toBe("")
    // No project association: no main task minted for the directory.
    expect(orch.listTasks().filter((t) => t.kind === "main")).toHaveLength(0)
  })

  it("opening the same directory twice creates two distinct tasks with distinct titles", async () => {
    const first = await orch.openDirectoryTask({ dir })
    const second = await orch.openDirectoryTask({ dir })
    expect(second.id).not.toBe(first.id)
    expect(second.title).not.toBe(first.title)
    expect(orch.listTasks()).toHaveLength(2)
  })

  it("titles carry the directory basename plus a random suffix", async () => {
    const task = await orch.openDirectoryTask({ dir })
    const base = dir.split("/").filter(Boolean).at(-1)
    expect(task.title).toMatch(new RegExp(`^${base}-[a-z0-9]{4}$`))
  })

  it("ensureWorktree returns the pinned directory without touching git", async () => {
    const task = await orch.openDirectoryTask({ dir })
    await expect(orch.ensureWorktree(task.id)).resolves.toBe(task.worktreePath)
    expect(worktrees.pathExists).not.toHaveBeenCalled()
  })

  it("can be archived like a regular task", async () => {
    const task = await orch.openDirectoryTask({ dir })
    await orch.setArchived(task.id)
    expect(orch.getTask(task.id)?.archived).toBe(true)
  })

  it("delete drops the index entry and NEVER removes the directory", async () => {
    const task = await orch.openDirectoryTask({ dir })
    // isDirty returns true — a dir task must skip the dirty gate entirely
    // (nothing on disk is at risk) and must never call worktrees.remove.
    await orch.deleteTask(task.id)
    expect(orch.getTask(task.id)).toBeUndefined()
    expect(worktrees.isDirty).not.toHaveBeenCalled()
    expect(worktrees.remove).not.toHaveBeenCalled()
  })

  it("refuses landTask and setBranch", async () => {
    const task = await orch.openDirectoryTask({ dir })
    await expect(orch.landTask(task.id)).rejects.toThrow(/directory task/)
    await expect(orch.setBranch(task.id, "x")).rejects.toThrow(/directory task/)
  })
})

describe("scratch tasks (issue #33)", () => {
  it("openDirectoryTask({scratch:true}) marks the row; a plain open does not", async () => {
    const scratch = await orch.openDirectoryTask({ dir, scratch: true })
    const plain = await orch.openDirectoryTask({ dir })
    expect(scratch.scratch).toBe(true)
    expect(plain.scratch).toBeUndefined()
  })

  it("a scratch task mints NO auto-name — title stays empty until named or adopted (issue #42)", async () => {
    const scratch = await orch.openDirectoryTask({ dir, scratch: true })
    expect(scratch.title).toBe("")
    // Adoption derives the title from the repo it lands in (rule ①).
    await orch.adoptScratchRepo(scratch.id, home)
    expect(orch.getTask(scratch.id)?.title).not.toBe("")
  })

  it("adoptScratchRepo repoints the task at the repo and clears the flag", async () => {
    const scratch = await orch.openDirectoryTask({ dir, scratch: true })
    await orch.adoptScratchRepo(scratch.id, home) // any existing dir works as "the repo"
    const adopted = orch.getTask(scratch.id)
    expect(adopted?.scratch).toBe(false)
    // canonPath realpaths (macOS /var → /private/var) — compare the tail.
    expect(adopted?.repo.endsWith(home.replace(/^\/private/, ""))).toBe(true)
    expect(adopted?.worktreePath).toBe(adopted?.repo)
    expect(adopted?.kind).toBe("dir")
  })

  it("adoptScratchRepo is a no-op on non-scratch rows", async () => {
    const plain = await orch.openDirectoryTask({ dir })
    await orch.adoptScratchRepo(plain.id, home)
    expect(orch.getTask(plain.id)?.repo).toBe(plain.repo)
  })

  it("renaming a scratch task clears the flag — naming is the keep gesture", async () => {
    const scratch = await orch.openDirectoryTask({ dir, scratch: true })
    await orch.setTitle(scratch.id, "my bench")
    const kept = orch.getTask(scratch.id)
    expect(kept?.scratch).toBe(false)
    expect(kept?.title).toBe("my bench")
  })

  it("the scratch flag survives a store reload (codec round-trip)", async () => {
    const scratch = await orch.openDirectoryTask({ dir, scratch: true })
    const reloaded = new TaskIndexStore({ homeDir: home })
    await reloaded.load()
    expect(reloaded.get(scratch.id)?.scratch).toBe(true)
  })
})
