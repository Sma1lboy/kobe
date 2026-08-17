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

  it("an empty title serializes with a display fallback — no consumer can render blank (issue #42)", () => {
    const scratch: Task = {
      id: toTaskId("s1"),
      title: "",
      repo: "/Users/me",
      branch: "",
      worktreePath: "/Users/me",
      kind: "dir",
      scratch: true,
      status: "backlog",
      archived: false,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    }
    expect(serializeTask(scratch).title).toBe("/Users/me")
    // Pathless too: never an empty string on the wire.
    expect(serializeTask({ ...scratch, repo: "", worktreePath: "" }).title).toBe("scratch")
  })
})
