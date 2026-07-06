import { describe, expect, it } from "vitest"
import {
  attentionCount,
  BASE_TITLE,
  documentTitle,
} from "../src/lib/document-title.ts"
import type { EngineState, Task } from "../src/lib/types.ts"

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    repo: "/repo",
    branch: `b/${id}`,
    worktreePath: `/wt/${id}`,
    kind: "task",
    status: "active",
    archived: false,
    pinned: false,
    createdAt: "2026-06-12T00:00:00Z",
    updatedAt: "2026-06-12T00:00:00Z",
    ...over,
  }
}

function engine(taskId: string, state: EngineState["state"]): EngineState {
  return { taskId, state, at: 0 }
}

describe("attentionCount", () => {
  it("counts waiting_permission / error / rate_limited (the Needs-you set)", () => {
    const tasks = [task("a"), task("b"), task("c")]
    const states = {
      a: engine("a", "waiting_permission"),
      b: engine("b", "error"),
      c: engine("c", "rate_limited"),
    }
    expect(attentionCount(tasks, states)).toBe(3)
  })

  it("does not count running / idle / missing-state tasks", () => {
    const tasks = [task("a"), task("b"), task("c")]
    const states = { a: engine("a", "running"), b: engine("b", "idle") }
    expect(attentionCount(tasks, states)).toBe(0)
  })

  it("ignores archived tasks and project (main) rows", () => {
    const tasks = [
      task("a", { archived: true }),
      task("m", { kind: "main" }),
      task("c"),
    ]
    const states = {
      a: engine("a", "error"),
      m: engine("m", "error"),
      c: engine("c", "error"),
    }
    expect(attentionCount(tasks, states)).toBe(1)
  })

  it("is zero for an empty workspace", () => {
    expect(attentionCount([], {})).toBe(0)
  })
})

describe("documentTitle", () => {
  it("prefixes the count when any task needs you", () => {
    expect(documentTitle(1)).toBe(`(1) ${BASE_TITLE}`)
    expect(documentTitle(5)).toBe(`(5) ${BASE_TITLE}`)
  })

  it("is the bare product name at zero", () => {
    expect(documentTitle(0)).toBe(BASE_TITLE)
  })
})
