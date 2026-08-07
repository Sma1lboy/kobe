import { describe, expect, it } from "vitest"
import { buildTaskContactPrompt } from "../../src/tui/workspace/task-messaging.ts"
import type { Task } from "../../src/types/task.ts"
import { toTaskId } from "../../src/types/task.ts"

function task(id: string, title: string): Task {
  return {
    id: toTaskId(id),
    title,
    repo: "/repo",
    worktreePath: `/repo/${id}`,
    branch: id,
    status: "in_progress",
    archived: false,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  }
}

describe("cross-task message address handoff", () => {
  it("gives the current agent both addresses without creating a protocol", () => {
    const prompt = buildTaskContactPrompt(task("SELF01", "primary"), task("PEER02", "worker"))

    expect(prompt).toContain("your_task_id: SELF01")
    expect(prompt).toContain("peer_task_id: PEER02")
    expect(prompt).toContain("reply_to_task_id: SELF01")
    expect(prompt).toContain("kobe api send")
    expect(prompt).toContain("does not create a channel, persist a relationship, or fork either chat")
    expect(prompt).not.toContain("request_id")
    expect(prompt).not.toContain("max_hops")
    expect(prompt).not.toContain("reply_policy")
  })
})
