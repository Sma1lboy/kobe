import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import type { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import { bootDaemonHarness, waitFor } from "./harness.ts"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

describe("background deletion over the daemon socket", () => {
  it("returns task.delete while physical worktree removal is still blocked", async () => {
    const home = await mkdtemp(join(tmpdir(), "kobe-delete-background-"))
    const store = new TaskIndexStore({ homeDir: home })
    await store.load()
    const task = await store.create({
      repo: "/repo",
      title: "large task",
      branch: "kobe/large-task",
      worktreePath: "/wt/large-task",
      status: "backlog",
      kind: "task",
      vendor: "claude",
    })

    let releaseRemoval: (() => void) | undefined
    const remove = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRemoval = resolve
        }),
    )
    const worktrees = {
      isDirty: vi.fn(async () => false),
      remove,
    } as unknown as GitWorktreeManager
    const orch = new Orchestrator({ store, worktrees })
    const harness = await bootDaemonHarness({ orchestrator: orch })
    cleanups.push(async () => {
      releaseRemoval?.()
      await harness.close()
      orch.dispose()
      await rm(home, { recursive: true, force: true })
    })
    const client = harness.client()
    await client.connect()

    const response = client.request("task.delete", { taskId: task.id })
    await expect(
      Promise.race([
        response.then(() => "returned"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 500)),
      ]),
    ).resolves.toBe("returned")
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce())
    expect(orch.getTask(task.id)?.deletion?.phase).toBe("running")

    releaseRemoval?.()
    expect(await waitFor(() => orch.getTask(task.id) === undefined)).toBe(true)
  })
})
