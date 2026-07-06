import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import {
  CannotDeleteMainTaskError,
  DirtyWorktreeError,
  IllegalTransitionError,
  TaskNotFoundError,
  WorktreeRemoveFailedError,
} from "../../src/orchestrator/errors.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import type { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import type { TaskPRStatus } from "../../src/types/task.ts"

let home: string
let store: TaskIndexStore
let orch: Orchestrator
let fakeWorktrees: {
  isDirty: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kobe-core-mutations-"))
  store = new TaskIndexStore({ homeDir: home })
  await store.load()
  fakeWorktrees = {
    isDirty: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
  }
  orch = new Orchestrator({ store, worktrees: fakeWorktrees as unknown as GitWorktreeManager })
})

afterEach(async () => {
  orch.dispose()
  await rm(home, { recursive: true, force: true })
})

async function makeTask(overrides: { title?: string; worktreePath?: string } = {}) {
  const task = await orch.createTask({ repo: "/repo", title: overrides.title ?? "t", vendor: "claude" })
  if (overrides.worktreePath) {
    await store.update(task.id, { worktreePath: overrides.worktreePath })
  }
  return orch.getTask(task.id)!
}

async function makeMainTask() {
  return store.create({
    repo: "/repo",
    title: "repo",
    branch: "",
    worktreePath: "/repo",
    status: "backlog",
    kind: "main",
    vendor: "claude",
  })
}

describe("setVendor", () => {
  it("persists a vendor change and no-ops on the same vendor", async () => {
    const t = await makeTask()
    await orch.setVendor(t.id, "codex")
    expect(orch.getTask(t.id)?.vendor).toBe("codex")

    const before = orch.getTask(t.id)?.updatedAt
    await orch.setVendor(t.id, "codex")
    expect(orch.getTask(t.id)?.updatedAt).toBe(before)
  })

  it("throws TaskNotFoundError for an unknown id", async () => {
    await expect(orch.setVendor("nope", "codex")).rejects.toThrow(TaskNotFoundError)
  })
})

describe("setPinned", () => {
  it("toggles when no explicit value is given", async () => {
    const t = await makeTask()
    await orch.setPinned(t.id)
    expect(orch.getTask(t.id)?.pinned).toBe(true)
    await orch.setPinned(t.id)
    expect(orch.getTask(t.id)?.pinned).toBe(false)
  })

  it("sets an explicit value and no-ops for main rows", async () => {
    const t = await makeTask()
    await orch.setPinned(t.id, true)
    expect(orch.getTask(t.id)?.pinned).toBe(true)

    const main = await makeMainTask()
    await orch.setPinned(main.id, true)
    expect(orch.getTask(main.id)?.pinned).toBeUndefined()
  })
})

describe("setArchived", () => {
  it("toggles and sets explicitly; main rows are refused silently", async () => {
    const t = await makeTask()
    await orch.setArchived(t.id)
    expect(orch.getTask(t.id)?.archived).toBe(true)
    await orch.setArchived(t.id, false)
    expect(orch.getTask(t.id)?.archived).toBe(false)

    const main = await makeMainTask()
    await orch.setArchived(main.id, true)
    expect(orch.getTask(main.id)?.archived).toBe(false)
  })
})

describe("setStatus", () => {
  it("moves between statuses and no-ops on the same status", async () => {
    const t = await makeTask()
    await orch.setStatus(t.id, "in_progress")
    expect(orch.getTask(t.id)?.status).toBe("in_progress")
    await orch.setStatus(t.id, "in_progress")
    expect(orch.getTask(t.id)?.status).toBe("in_progress")
  })

  it("refuses done ↔ error flip-flops in both directions", async () => {
    const t = await makeTask()
    await orch.setStatus(t.id, "done")
    await expect(orch.setStatus(t.id, "error")).rejects.toThrow(IllegalTransitionError)

    const u = await makeTask({ title: "u" })
    await orch.setStatus(u.id, "error")
    await expect(orch.setStatus(u.id, "done")).rejects.toThrow(IllegalTransitionError)
  })
})

describe("setPRStatus", () => {
  const pr: TaskPRStatus = { provider: "github", lifecycle: "open", checkState: "passing", number: 7 }

  it("sets, diffs (no redundant write), and clears with null", async () => {
    const t = await makeTask()
    await orch.setPRStatus(t.id, pr)
    expect(orch.getTask(t.id)?.prStatus).toMatchObject({ provider: "github", number: 7 })

    const before = orch.getTask(t.id)?.updatedAt
    await orch.setPRStatus(t.id, { ...pr })
    expect(orch.getTask(t.id)?.updatedAt).toBe(before)

    await orch.setPRStatus(t.id, null)
    expect(orch.getTask(t.id)?.prStatus).toBeUndefined()
  })
})

describe("moveTask", () => {
  it("moves a task within its partition and skips archived/pinned siblings", async () => {
    const a = await makeTask({ title: "a" })
    const b = await makeTask({ title: "b" })
    const c = await makeTask({ title: "c" })
    await orch.setArchived(b.id, true)

    await orch.moveTask(c.id, -1)
    const order = orch
      .listTasks()
      .filter((t) => !t.archived)
      .map((t) => t.title)
    expect(order).toEqual(["c", "a"])
  })

  it("no-ops for main rows", async () => {
    const main = await makeMainTask()
    const before = orch.listTasks().map((t) => t.id)
    await orch.moveTask(main.id, 1)
    expect(orch.listTasks().map((t) => t.id)).toEqual(before)
  })
})

describe("reorderTasks", () => {
  it("assigns board positions in one batch", async () => {
    const a = await makeTask({ title: "a" })
    const b = await makeTask({ title: "b" })
    await orch.reorderTasks([
      { taskId: String(a.id), position: 2 },
      { taskId: String(b.id), position: 1 },
    ])
    expect(orch.getTask(a.id)?.position).toBe(2)
    expect(orch.getTask(b.id)?.position).toBe(1)
  })

  it("is all-or-nothing: one bad entry fails the batch before anything persists", async () => {
    const a = await makeTask({ title: "a" })
    await expect(
      orch.reorderTasks([
        { taskId: String(a.id), position: 1 },
        { taskId: String(a.id), position: Number.NaN },
      ]),
    ).rejects.toThrow(/finite/)
    expect(orch.getTask(a.id)?.position).toBeUndefined()

    const main = await makeMainTask()
    await expect(orch.reorderTasks([{ taskId: String(main.id), position: 1 }])).rejects.toThrow(/main/)

    await expect(orch.reorderTasks([])).resolves.toBeUndefined()
  })
})

describe("deleteTask — safety ladder", () => {
  it("silently no-ops for an unknown id", async () => {
    await expect(orch.deleteTask("nope")).resolves.toBeUndefined()
  })

  it("refuses main rows with CannotDeleteMainTaskError", async () => {
    const main = await makeMainTask()
    await expect(orch.deleteTask(main.id)).rejects.toThrow(CannotDeleteMainTaskError)
    expect(orch.getTask(main.id)).toBeDefined()
  })

  it("throws DirtyWorktreeError for a dirty worktree without force, keeping everything", async () => {
    const t = await makeTask({ worktreePath: "/wt/dirty" })
    fakeWorktrees.isDirty.mockResolvedValue(true)

    await expect(orch.deleteTask(t.id)).rejects.toThrow(DirtyWorktreeError)
    expect(fakeWorktrees.remove).not.toHaveBeenCalled()
    expect(orch.getTask(t.id)).toBeDefined()
  })

  it("force bypasses the dirty check and removes worktree + entry", async () => {
    const t = await makeTask({ worktreePath: "/wt/dirty" })
    fakeWorktrees.isDirty.mockResolvedValue(true)

    await orch.deleteTask(t.id, { force: true })

    expect(fakeWorktrees.isDirty).not.toHaveBeenCalled()
    expect(fakeWorktrees.remove).toHaveBeenCalledWith("/wt/dirty", { force: true })
    expect(orch.getTask(t.id)).toBeUndefined()
  })

  it("an isDirty failure is treated as clean (remove decides on the missing dir)", async () => {
    const t = await makeTask({ worktreePath: "/wt/gone" })
    fakeWorktrees.isDirty.mockRejectedValue(new Error("not a worktree"))

    await orch.deleteTask(t.id)

    expect(fakeWorktrees.remove).toHaveBeenCalledWith("/wt/gone", { force: false })
    expect(orch.getTask(t.id)).toBeUndefined()
  })

  it("a failed worktree remove throws WorktreeRemoveFailedError and KEEPS the index entry", async () => {
    const t = await makeTask({ worktreePath: "/wt/locked" })
    fakeWorktrees.remove.mockRejectedValue(new Error("locked"))

    await expect(orch.deleteTask(t.id)).rejects.toThrow(WorktreeRemoveFailedError)
    expect(orch.getTask(t.id)).toBeDefined()
  })

  it("a lazily-created task (no worktree yet) skips git entirely", async () => {
    const t = await makeTask()
    await orch.deleteTask(t.id)
    expect(fakeWorktrees.isDirty).not.toHaveBeenCalled()
    expect(fakeWorktrees.remove).not.toHaveBeenCalled()
    expect(orch.getTask(t.id)).toBeUndefined()
  })
})

describe("signals + subscription surface", () => {
  it("tasksSignal reflects store mutations; subscribeTasks fires on create", async () => {
    const seen: number[] = []
    const unsub = orch.subscribeTasks((snapshot) => {
      seen.push(snapshot.length)
    })
    await makeTask()
    expect(seen.at(-1)).toBe(1)
    expect(orch.tasksSignal()()).toHaveLength(1)
    unsub()
    await makeTask({ title: "second" })
    expect(seen.at(-1)).toBe(1)
  })

  it("setActiveTask publishes to activeTaskSignal and clears with null", async () => {
    const t = await makeTask()
    await orch.setActiveTask(t.id)
    expect(orch.activeTaskSignal()()).toBe(String(t.id))
    await orch.setActiveTask(null)
    expect(orch.activeTaskSignal()()).toBeNull()
  })

  it("createTask blanks a whitespace-only title to the placeholder and requires a repo", async () => {
    const t = await orch.createTask({ repo: "/repo", title: "   " })
    expect(t.title).toBe("(new task)")
    await expect(orch.createTask({ repo: "" })).rejects.toThrow(/repo is required/)
  })
})
