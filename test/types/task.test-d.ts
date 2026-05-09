/**
 * Type-level tests for src/types/task.ts.
 */
import { describe, expectTypeOf, it } from "vitest"
import type { Task, TaskId, TaskIndex, TaskStatus } from "../../src/types/task.ts"
import { toTaskId } from "../../src/types/task.ts"

describe("TaskStatus", () => {
  it("is the documented six-variant union", () => {
    expectTypeOf<TaskStatus>().toEqualTypeOf<"backlog" | "in_progress" | "in_review" | "done" | "canceled" | "error">()
  })

  it("rejects unknown statuses", () => {
    // @ts-expect-error — "frozen" is not a TaskStatus
    const _bad: TaskStatus = "frozen"
    void _bad
  })
})

describe("TaskId", () => {
  it("is structurally a string but not assignable from a bare string", () => {
    expectTypeOf<TaskId>().toMatchTypeOf<string>()
    // @ts-expect-error — bare strings can't sneak in without going through `toTaskId`.
    const _bad: TaskId = "01HZ..."
    void _bad
  })

  it("toTaskId returns a TaskId", () => {
    expectTypeOf(toTaskId("01HZ...")).toEqualTypeOf<TaskId>()
  })
})

describe("Task", () => {
  it("has all documented fields with correct types", () => {
    expectTypeOf<Task["id"]>().toEqualTypeOf<TaskId>()
    expectTypeOf<Task["title"]>().toEqualTypeOf<string>()
    expectTypeOf<Task["repo"]>().toEqualTypeOf<string>()
    expectTypeOf<Task["branch"]>().toEqualTypeOf<string>()
    expectTypeOf<Task["worktreePath"]>().toEqualTypeOf<string>()
    expectTypeOf<Task["sessionId"]>().toEqualTypeOf<string | null>()
    expectTypeOf<Task["status"]>().toEqualTypeOf<TaskStatus>()
    expectTypeOf<Task["createdAt"]>().toEqualTypeOf<string>()
    expectTypeOf<Task["updatedAt"]>().toEqualTypeOf<string>()
  })

  it("rejects excess properties on a fresh Task literal", () => {
    const _good: Task = {
      id: toTaskId("01HZ..."),
      title: "t",
      repo: "/r",
      branch: "kobe/x",
      worktreePath: "/r/.kobe/wt/x",
      sessionId: null,
      status: "backlog",
      createdAt: "2026-05-08T00:00:00Z",
      updatedAt: "2026-05-08T00:00:00Z",
    }
    void _good

    // @ts-expect-error — `priority` is not a Task field
    const _bad: Task = { ..._good, priority: 1 }
    void _bad
  })
})

describe("TaskIndex", () => {
  it("pins version to literal 1", () => {
    expectTypeOf<TaskIndex["version"]>().toEqualTypeOf<1>()
    // @ts-expect-error — version 2 must wait for an explicit migration bump.
    const _bad: TaskIndex = { version: 2, tasks: [] }
    void _bad
  })

  it("tasks is a readonly array of Task", () => {
    expectTypeOf<TaskIndex["tasks"]>().toEqualTypeOf<readonly Task[]>()
  })
})
