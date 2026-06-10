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
    const store = new TaskIndexStore({ homeDir: home })
    await store.load()
    orch = new Orchestrator({ store, worktrees: new GitWorktreeManager() })
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.useRealTimers()
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
})
