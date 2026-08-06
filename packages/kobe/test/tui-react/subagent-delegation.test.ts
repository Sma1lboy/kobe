import { describe, expect, test } from "vitest"
import { buildDelegationBootstrapPrompt } from "../../src/tui/workspace/task-delegation.ts"
import { type Task, toTaskId } from "../../src/types/task.ts"

function task(id: string, title: string): Task {
  return {
    id: toTaskId(id),
    title,
    repo: `/repo/${id}`,
    branch: `kobe/${id}`,
    worktreePath: `/wt/${id}`,
    status: "in_progress",
    archived: false,
    vendor: "codex",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  }
}

describe("subagent delegation bootstrap", () => {
  test("addresses both roles explicitly and forbids channel/fork semantics", () => {
    const prompt = buildDelegationBootstrapPrompt(task("PRIMARY01", "Coordinator"), task("WORKER01", "Research"))
    expect(prompt).toContain("You are the PRIMARY agent")
    expect(prompt).toContain("primary_task_id: PRIMARY01")
    expect(prompt).toContain("subagent_task_id: WORKER01")
    expect(prompt).toContain("kobe api send --task-id WORKER01")
    expect(prompt).toContain("kobe api send --task-id PRIMARY01")
    expect(prompt).toContain("no shared channel was created")
    expect(prompt).toContain("Do not recursively delegate")
  })
})
