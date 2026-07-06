import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type TaskCreateInput, TaskIndexStore } from "../../src/orchestrator/index/store.ts"

/**
 * Multi-process consistency for the task index (fix B). Two kobe instances
 * (TUI + daemon + CLI) write the SAME `~/.kobe/tasks.json`. Before the lock +
 * read-merge-write, a save serialized the writer's WHOLE in-memory snapshot,
 * so process B silently clobbered the task process A had just created (lost
 * update). These tests pin the two guarantees the fix adds: interleaved writes
 * keep BOTH tasks, and the lock is actually taken on the write path so two
 * processes can't physically race.
 */
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

  /** Read the on-disk manifest directly — the source of truth, not a cache. */
  async function readDisk(): Promise<{ tasks: Array<{ id: string; title: string }> }> {
    const raw = await readFile(join(home, ".kobe", "tasks.json"), "utf8")
    return JSON.parse(raw)
  }

  it("keeps both tasks when two processes create concurrently", async () => {
    // Two independent stores on the SAME home = two kobe processes.
    const procA = new TaskIndexStore({ homeDir: home })
    const procB = new TaskIndexStore({ homeDir: home })
    await procA.load()
    await procB.load()

    // Interleave the two creates. Without the lock + merge, whichever wrote
    // last would persist only its own task (it based the write on its empty
    // load snapshot). With the fix the loser re-reads, finds the peer's task,
    // and merges its own on top.
    const [taskA, taskB] = await Promise.all([procA.create(input("alpha")), procB.create(input("beta"))])

    const disk = await readDisk()
    const ids = disk.tasks.map((t) => t.id).sort()
    expect(ids).toEqual([taskA.id, taskB.id].sort())
    expect(disk.tasks.map((t) => t.title).sort()).toEqual(["alpha", "beta"])
  })

  it("does not resurrect a task a peer process deleted", async () => {
    // A creates a task and persists it; B loads and sees it.
    const procA = new TaskIndexStore({ homeDir: home })
    await procA.load()
    const task = await procA.create(input("doomed"))

    const procB = new TaskIndexStore({ homeDir: home })
    await procB.load()
    expect(procB.get(task.id)).toBeDefined()

    // A removes it (disk no longer has it). B then writes an UNRELATED create.
    // B's stale cache still holds the doomed task, but the merge must take the
    // peer's deletion as truth and not write it back.
    await procA.remove(task.id)
    const survivor = await procB.create(input("survivor"))

    const disk = await readDisk()
    const ids = disk.tasks.map((t) => t.id)
    expect(ids).toContain(survivor.id)
    expect(ids).not.toContain(task.id)
  })

  it("does not resurrect a task this process deleted from a stale disk copy", async () => {
    // Seed disk with one task, load it, delete it. The merge reads the still-
    // present on-disk row but must honor the in-flight removal.
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

    // Externally hold the index lock with a LIVE holder (our own pid). A save
    // must spin on `acquire` and not complete while the lock is held — this is
    // what proves the lock guards the write path rather than being dead code.
    const lockPath = join(home, ".kobe", "tasks.json.lock")
    await writeFile(lockPath, String(process.pid), "utf8")

    let settled = false
    const createP = store.create(input("blocked")).then((task) => {
      settled = true
      return task
    })

    // Spin window well under the retry deadline; the create must still be pending.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(settled).toBe(false)

    // Release the lock; the queued write now proceeds and persists.
    await rm(lockPath)
    const task = await createP
    expect(settled).toBe(true)
    expect(store.get(task.id)).toBeDefined()
    const disk = await readDisk()
    expect(disk.tasks.map((t) => t.id)).toContain(task.id)
  })
})
