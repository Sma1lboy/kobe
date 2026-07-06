import { describe, expect, it } from "vitest"
import { type StatusRuleOrchestrator, maybeAutoStart } from "../../src/monitor/status-rules.ts"
import type { Task, TaskStatus } from "../../src/types/task.ts"

const task = (over: Partial<Task>): Task =>
  ({
    id: "t1",
    title: "demo",
    repo: "/repo",
    branch: "kobe/demo",
    worktreePath: "/repo/.kobe/worktrees/demo",
    kind: "task",
    status: "backlog",
    archived: false,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    ...over,
  }) as Task

function fakeOrch(initial: Task | undefined): StatusRuleOrchestrator & {
  moves: Array<[string, TaskStatus]>
} {
  return {
    moves: [],
    getTask: () => initial,
    async setStatus(id: string, status: TaskStatus) {
      this.moves.push([id, status])
    },
  }
}

describe("maybeAutoStart", () => {
  it("moves a backlog task to in_progress when enabled", async () => {
    const orch = fakeOrch(task({}))
    await expect(maybeAutoStart(orch, "t1", () => true)).resolves.toBe("moved")
    expect(orch.moves).toEqual([["t1", "in_progress"]])
  })

  it("does nothing when the flag is off (default)", async () => {
    const orch = fakeOrch(task({}))
    await expect(maybeAutoStart(orch, "t1", () => false)).resolves.toBe("skipped")
    expect(orch.moves).toEqual([])
  })

  it("never touches a task the user placed anywhere else", async () => {
    for (const status of ["in_progress", "in_review", "done", "canceled", "error"] as const) {
      const orch = fakeOrch(task({ status }))
      await expect(maybeAutoStart(orch, "t1", () => true)).resolves.toBe("skipped")
      expect(orch.moves).toEqual([])
    }
  })

  it("skips main / archived / missing tasks", async () => {
    for (const t of [task({ kind: "main" }), task({ archived: true }), undefined]) {
      const orch = fakeOrch(t)
      await expect(maybeAutoStart(orch, "t1", () => true)).resolves.toBe("skipped")
      expect(orch.moves).toEqual([])
    }
  })
})
