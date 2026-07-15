import { describe, expect, it, vi } from "vitest"
import type { DaemonOrchestrator, DaemonTask } from "../../../kobe-daemon/src/daemon/contracts.ts"
import { TaskDeletionRunner } from "../../../kobe-daemon/src/daemon/task-deletion-runner.ts"

function task(id: string, phase: "queued" | "running" | "error"): DaemonTask {
  return {
    id,
    title: id,
    repo: "/repo",
    branch: "branch",
    worktreePath: `/wt/${id}`,
    kind: "task",
    status: "backlog",
    archived: false,
    deletion: { phase, force: false, requestedAt: "2026-07-15T00:00:00.000Z" },
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  }
}

describe("TaskDeletionRunner", () => {
  it("deduplicates requests and preserves begin -> session teardown -> cleanup ordering", async () => {
    const order: string[] = []
    let releaseFinish: (() => void) | undefined
    const orch = {
      beginTaskDeletion: vi.fn(async () => {
        order.push("begin")
        return true
      }),
      finishTaskDeletion: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            order.push("finish")
            releaseFinish = resolve
          }),
      ),
    } as unknown as DaemonOrchestrator
    const tearDownTaskSession = vi.fn(async () => {
      order.push("teardown")
    })
    const clearActivity = vi.fn()
    const runner = new TaskDeletionRunner(orch, { tearDownTaskSession }, clearActivity)

    runner.enqueue("t1")
    runner.enqueue("t1")
    await vi.waitFor(() => expect(releaseFinish).toBeTypeOf("function"))
    expect(order).toEqual(["begin", "teardown", "finish"])
    expect(orch.beginTaskDeletion).toHaveBeenCalledTimes(1)
    expect(orch.finishTaskDeletion).toHaveBeenCalledTimes(1)
    expect(clearActivity).toHaveBeenCalledWith("t1")

    releaseFinish?.()
    await runner.drain()
  })

  it("resumes queued/running records on startup but leaves terminal errors for manual retry", async () => {
    const begun: string[] = []
    const orch = {
      beginTaskDeletion: vi.fn(async (id: string) => {
        begun.push(id)
        return true
      }),
      finishTaskDeletion: vi.fn(async () => {}),
    } as unknown as DaemonOrchestrator
    const runner = new TaskDeletionRunner(orch, { tearDownTaskSession: async () => {} }, () => {})

    runner.resume([task("queued", "queued"), task("running", "running"), task("failed", "error")])
    await runner.drain()

    expect(begun.sort()).toEqual(["queued", "running"])
    expect(orch.finishTaskDeletion).toHaveBeenCalledTimes(2)
  })
})
