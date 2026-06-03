import { describe, expect, test } from "vitest"
import { chooseInitialTask } from "../../src/tui/direct"
import { type Task, toTaskId } from "../../src/types/task"

function task(overrides: Partial<Omit<Task, "id">> & { id: string }): Task {
  return {
    id: toTaskId(overrides.id),
    title: overrides.title ?? overrides.id,
    repo: overrides.repo ?? "/repo",
    branch: overrides.branch ?? "main",
    worktreePath: overrides.worktreePath ?? "/repo",
    kind: overrides.kind ?? "task",
    status: overrides.status ?? "backlog",
    archived: overrides.archived ?? false,
    pinned: overrides.pinned ?? false,
    vendor: overrides.vendor ?? "claude",
    prStatus: overrides.prStatus,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
  }
}

describe("chooseInitialTask", () => {
  test("prefers the active task, then the persisted task", () => {
    const tasks = [task({ id: "a" }), task({ id: "b" }), task({ id: "c" })]
    expect(chooseInitialTask(tasks, { activeTaskId: "b", persistedTaskId: "c" })?.id).toBe("b")
    expect(chooseInitialTask(tasks, { persistedTaskId: "c" })?.id).toBe("c")
  })

  test("falls back to cwd main task, pinned visible task, then first visible task", () => {
    const tasks = [
      task({ id: "archived", archived: true }),
      task({ id: "main", kind: "main", repo: "/cwd" }),
      task({ id: "pinned", pinned: true }),
      task({ id: "visible" }),
    ]
    expect(chooseInitialTask(tasks, { cwdRepo: "/cwd" })?.id).toBe("main")
    expect(chooseInitialTask(tasks)?.id).toBe("pinned")
    expect(chooseInitialTask([task({ id: "archived", archived: true }), task({ id: "visible" })])?.id).toBe("visible")
  })
})
