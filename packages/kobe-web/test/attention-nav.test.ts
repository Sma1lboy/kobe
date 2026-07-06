import { describe, expect, it } from "vitest"
import {
  attentionTaskIds,
  nextAttentionTaskId,
} from "../src/lib/attention-nav.ts"
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

const engine = (taskId: string, state: EngineState["state"]): EngineState => ({
  taskId,
  state,
  at: 0,
})

describe("attentionTaskIds", () => {
  it("keeps the Needs-you set in task order", () => {
    const tasks = [task("a"), task("b"), task("c"), task("d")]
    const states = {
      a: engine("a", "running"),
      b: engine("b", "waiting_permission"),
      c: engine("c", "idle"),
      d: engine("d", "error"),
    }
    expect(attentionTaskIds(tasks, states)).toEqual(["b", "d"])
  })

  it("excludes archived tasks and project rows even when waiting", () => {
    const tasks = [
      task("a", { archived: true }),
      task("m", { kind: "main" }),
      task("c"),
    ]
    const states = {
      a: engine("a", "error"),
      m: engine("m", "error"),
      c: engine("c", "rate_limited"),
    }
    expect(attentionTaskIds(tasks, states)).toEqual(["c"])
  })
})

describe("nextAttentionTaskId", () => {
  it("returns null when nothing needs you", () => {
    expect(nextAttentionTaskId([], "a")).toBeNull()
    expect(nextAttentionTaskId([], null)).toBeNull()
  })

  it("opens the first when the active task isn't waiting", () => {
    expect(nextAttentionTaskId(["b", "d"], null)).toBe("b")
    expect(nextAttentionTaskId(["b", "d"], "a")).toBe("b")
  })

  it("cycles to the next waiting task after the active one", () => {
    expect(nextAttentionTaskId(["b", "d", "f"], "b")).toBe("d")
    expect(nextAttentionTaskId(["b", "d", "f"], "d")).toBe("f")
  })

  it("wraps from the last waiting task to the first", () => {
    expect(nextAttentionTaskId(["b", "d", "f"], "f")).toBe("b")
  })

  it("a single waiting task that is active re-selects itself", () => {
    expect(nextAttentionTaskId(["b"], "b")).toBe("b")
  })
})
