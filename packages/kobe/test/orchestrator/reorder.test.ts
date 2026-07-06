import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"

describe("TaskIndexStore.reorder", () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kobe-reorder-"))
    await mkdir(join(home, ".kobe"), { recursive: true })
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  function row(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id,
      title: id,
      repo: "/repo",
      branch: `kobe/${id}`,
      worktreePath: `/repo/.kobe/worktrees/${id}`,
      kind: "task",
      status: "backlog",
      archived: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      ...over,
    }
  }

  async function writeTasks(tasks: unknown[]): Promise<TaskIndexStore> {
    await writeFile(join(home, ".kobe", "tasks.json"), JSON.stringify({ version: 3, tasks }), "utf8")
    const store = new TaskIndexStore({ homeDir: home })
    await store.load()
    return store
  }

  it("assigns positions without bumping updatedAt, one notification per batch", async () => {
    const store = await writeTasks([row("a"), row("b")])
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })
    notifications = 0

    await store.reorder([
      { id: "a", position: 1000 },
      { id: "b", position: 2000 },
    ])

    const a = store.get("a")
    const b = store.get("b")
    expect(a?.position).toBe(1000)
    expect(b?.position).toBe(2000)
    expect(a?.updatedAt).toBe("2026-01-02T00:00:00.000Z")
    expect(notifications).toBe(1)
  })

  it("skips the save entirely when every position is already current", async () => {
    const store = await writeTasks([row("a", { position: 5 })])
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })
    notifications = 0
    await store.reorder([{ id: "a", position: 5 }])
    expect(notifications).toBe(0)
  })

  it("fails the whole batch on a missing id with the cache untouched", async () => {
    const store = await writeTasks([row("a")])
    await expect(
      store.reorder([
        { id: "a", position: 7 },
        { id: "ghost", position: 8 },
      ]),
    ).rejects.toThrow("task not found: ghost")
    expect(store.get("a")?.position).toBeUndefined()
  })

  it("position survives a reload (coerceTask keeps the field)", async () => {
    const store = await writeTasks([row("a")])
    await store.reorder([{ id: "a", position: 42.5 }])

    const reloaded = new TaskIndexStore({ homeDir: home })
    await reloaded.load()
    expect(reloaded.get("a")?.position).toBe(42.5)
  })

  it("drops a non-numeric persisted position at load instead of crashing", async () => {
    const store = await writeTasks([row("a", { position: "garbage" })])
    expect(store.get("a")?.position).toBeUndefined()
  })
})
