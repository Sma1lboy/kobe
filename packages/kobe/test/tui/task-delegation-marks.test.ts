import { describe, expect, it } from "vitest"
import {
  delegationTitleBudget,
  indexTaskDelegationMarks,
  linkedSubagents,
} from "../../src/tui/panes/sidebar/task-delegation-marks.ts"
import { type Task, toTaskId } from "../../src/types/task.ts"

function task(id: string, primaryTaskId?: string): Task {
  return {
    id: toTaskId(id),
    title: id,
    repo: "/repo",
    branch: id,
    worktreePath: `/repo/${id}`,
    kind: "task",
    status: "backlog",
    archived: false,
    pinned: false,
    vendor: "claude",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...(primaryTaskId
      ? { delegation: { primaryTaskId, protocolVersion: 2, linkedAt: "2026-08-07T00:00:00.000Z" } }
      : {}),
  }
}

describe("task delegation sidebar marks", () => {
  it("projects one durable link onto both the primary and subagent rows", () => {
    const marks = indexTaskDelegationMarks([task("primary"), task("worker", "primary")])
    expect(marks.get("primary")).toEqual({ isSubagent: false, subagentCount: 1 })
    expect(marks.get("worker")).toEqual({ isSubagent: true, subagentCount: 0 })
  })

  it("counts fan-out and preserves both roles in an explicit chain", () => {
    const marks = indexTaskDelegationMarks([
      task("root"),
      task("middle", "root"),
      task("leaf-a", "middle"),
      task("leaf-b", "middle"),
    ])
    expect(marks.get("root")?.subagentCount).toBe(1)
    expect(marks.get("middle")).toEqual({ isSubagent: true, subagentCount: 2 })
  })

  it("reserves cells only for marks that render", () => {
    expect(delegationTitleBudget(20, undefined)).toBe(20)
    expect(delegationTitleBudget(20, { isSubagent: true, subagentCount: 12 })).toBe(10)
  })

  it("resolves a primary entry to its linked Tasks without moving them", () => {
    const tasks = [task("root"), task("unrelated"), task("worker-a", "root"), task("worker-b", "root")]
    expect(linkedSubagents(tasks, "root").map(({ id }) => id)).toEqual(["worker-a", "worker-b"])
  })
})
