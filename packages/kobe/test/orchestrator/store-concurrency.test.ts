import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type TaskCreateInput, TaskIndexStore } from "../../src/orchestrator/index/store.ts"

describe("TaskIndexStore multi-process consistency", () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kobe-store-concurrency-"))
    await mkdir(join(home, ".kobe"), { recursive: true })
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  function input(title: string): TaskCreateInput {
    return {
      title,
      repo: "/repo",
      branch: `kobe/${title}`,
      worktreePath: `/repo/.kobe/worktrees/${title}`,
      kind: "task",
      status: "backlog",
    }
  }

  async function readDisk(): Promise<{ tasks: Array<{ id: string; title: string }> }> {
    const raw = await readFile(join(home, ".kobe", "tasks.json"), "utf8")
    return JSON.parse(raw)
  }

  it("keeps both tasks when two processes create concurrently", async () => {
    const procA = new TaskIndexStore({ homeDir: home })
    const procB = new TaskIndexStore({ homeDir: home })
    await procA.load()
    await procB.load()

    const [taskA, taskB] = await Promise.all([procA.create(input("alpha")), procB.create(input("beta"))])

    const disk = await readDisk()
    const ids = disk.tasks.map((t) => t.id).sort()
    expect(ids).toEqual([taskA.id, taskB.id].sort())
    expect(disk.tasks.map((t) => t.title).sort()).toEqual(["alpha", "beta"])
  })

  it("does not resurrect a task a peer process deleted", async () => {
    const procA = new TaskIndexStore({ homeDir: home })
    await procA.load()
    const task = await procA.create(input("doomed"))

    const procB = new TaskIndexStore({ homeDir: home })
    await procB.load()
    expect(procB.get(task.id)).toBeDefined()

    await procA.remove(task.id)
    const survivor = await procB.create(input("survivor"))

    const disk = await readDisk()
    const ids = disk.tasks.map((t) => t.id)
    expect(ids).toContain(survivor.id)
    expect(ids).not.toContain(task.id)
  })

  it("does not resurrect a task this process deleted from a stale disk copy", async () => {
    await writeFile(
      join(home, ".kobe", "tasks.json"),
      JSON.stringify({
        version: 3,
        tasks: [
          {
            ...input("gone"),
            id: "01J0000000000000000000GONE",
            archived: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    )
    const store = new TaskIndexStore({ homeDir: home })
    await store.load()
    await store.remove("01J0000000000000000000GONE")

    const disk = await readDisk()
    expect(disk.tasks).toHaveLength(0)
  })

  it("blocks the write path on the index lock", async () => {
    const store = new TaskIndexStore({ homeDir: home })
    await store.load()

    const lockPath = join(home, ".kobe", "tasks.json.lock")
    await writeFile(lockPath, String(process.pid), "utf8")

    let settled = false
    const createP = store.create(input("blocked")).then((task) => {
      settled = true
      return task
    })

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(settled).toBe(false)

    await rm(lockPath)
    const task = await createP
    expect(settled).toBe(true)
    expect(store.get(task.id)).toBeDefined()
    const disk = await readDisk()
    expect(disk.tasks.map((t) => t.id)).toContain(task.id)
  })
})
