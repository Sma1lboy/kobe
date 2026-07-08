import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"

describe("Orchestrator active task recency", () => {
  let home: string
  let orch: Orchestrator

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kobe-active-task-"))
    // Isolate the global `lastActive` record (state/last-active.ts writes
    // through kvStatePath(), which honours KOBE_HOME_DIR).
    vi.stubEnv("KOBE_HOME_DIR", home)
    const store = new TaskIndexStore({ homeDir: home })
    await store.load()
    orch = new Orchestrator({ store, worktrees: new GitWorktreeManager() })
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    orch.dispose()
    await rm(home, { recursive: true, force: true })
  })

  it("touches updatedAt when a task becomes active", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    const task = await orch.createTask({
      repo: "/repo",
      title: "first",
      branch: "first",
      vendor: "claude",
    })

    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"))
    await orch.setActiveTask(task.id)

    expect(orch.getTask(task.id)?.updatedAt).toBe("2026-01-02T00:00:00.000Z")
  })

  // The `lastActive` contract (state/last-active.ts): whoever focused last
  // wins globally, and a fresh orchestrator (daemon restart, new `kobe`)
  // opens on that task instead of null → "first in the list".
  it("restores the persisted lastActive focus in a fresh orchestrator", async () => {
    const task = await orch.createTask({ repo: "/repo", title: "t", branch: "t", vendor: "claude" })
    await orch.setActiveTask(task.id)

    const store2 = new TaskIndexStore({ homeDir: home })
    await store2.load()
    const orch2 = new Orchestrator({ store: store2, worktrees: new GitWorktreeManager() })
    expect(orch2.activeTaskSignal()()).toBe(task.id)
    orch2.dispose()
  })

  it("drops a persisted lastActive whose task no longer exists", async () => {
    const task = await orch.createTask({ repo: "/repo", title: "t", branch: "t", vendor: "claude" })
    await orch.setActiveTask(task.id)
    await orch.deleteTask(task.id)

    const store2 = new TaskIndexStore({ homeDir: home })
    await store2.load()
    const orch2 = new Orchestrator({ store: store2, worktrees: new GitWorktreeManager() })
    expect(orch2.activeTaskSignal()()).toBeNull()
    orch2.dispose()
  })
})
