import { serializeTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { describe, expect, it } from "vitest"
import { deserializeTask } from "../../src/client/remote-orchestrator-payloads.ts"
import type { Task } from "../../src/types/task.ts"
import { toTaskId } from "../../src/types/task.ts"

describe("task deletion wire state", () => {
  it("round-trips durable deletion state through daemon serialization", () => {
    const task: Task = {
      id: toTaskId("t1"),
      title: "task",
      repo: "/repo",
      branch: "branch",
      worktreePath: "/wt/task",
      kind: "task",
      status: "backlog",
      archived: false,
      deletion: {
        phase: "error",
        force: true,
        requestedAt: "2026-07-15T00:00:00.000Z",
        error: "locked",
      },
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    }

    const wire = serializeTask(task)
    expect(wire.deletion).toEqual(task.deletion)
    expect(deserializeTask(wire).deletion).toEqual(task.deletion)
  })
})
