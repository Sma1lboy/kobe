import {
  type DaemonHandlerContext,
  createDaemonHandlerRegistry,
  dispatchDaemonRequest,
} from "@sma1lboy/kobe-daemon/daemon/server"
import { describe, expect, it } from "vitest"
import { fakeCtx } from "./handler-test-context.ts"

/**
 * `task.report` dispatch tests — the worker-side half of the supervision
 * contract. Pins: the verdict is stored VERBATIM (worker report, not
 * kobe-verified — the handler never remaps or infers), `taskId` wins over
 * `cwd`, cwd resolves by worktree path, and an unmatched report is a LOUD
 * error (a lost verdict must never look like success).
 */

function dispatch(name: string, payload: unknown, ctx: DaemonHandlerContext): Promise<unknown> {
  return dispatchDaemonRequest(createDaemonHandlerRegistry(), name, payload, ctx)
}

function reportingCtx(tasks: Array<{ id: string; worktreePath: string }> = []) {
  const stored: Array<{ id: string; report: Record<string, unknown> }> = []
  const { ctx } = fakeCtx({
    listTasks: () => tasks,
    setWorkerReport: async (id: string, report: Record<string, unknown>) => {
      stored.push({ id, report })
    },
  })
  return { ctx, stored }
}

describe("task.report", () => {
  it("stores the verdict verbatim with a daemon-stamped reportedAt and echoes it", async () => {
    const { ctx, stored } = reportingCtx()
    const before = Date.now()
    const result = (await dispatch(
      "task.report",
      { taskId: "t1", outcome: "succeeded", summary: "all green" },
      ctx,
    )) as { taskId: string; workerReport: { outcome: string; summary?: string; reportedAt: string } }
    expect(result.taskId).toBe("t1")
    expect(result.workerReport.outcome).toBe("succeeded")
    expect(result.workerReport.summary).toBe("all green")
    expect(Date.parse(result.workerReport.reportedAt)).toBeGreaterThanOrEqual(before - 1000)
    expect(stored).toEqual([{ id: "t1", report: result.workerReport }])
  })

  it("accepts failed, with the summary optional", async () => {
    const { ctx, stored } = reportingCtx()
    await dispatch("task.report", { taskId: "t1", outcome: "failed" }, ctx)
    expect(stored[0].report.outcome).toBe("failed")
    expect(stored[0].report.summary).toBeUndefined()
  })

  it("rejects any outcome that is not an explicit succeeded/failed", async () => {
    const { ctx, stored } = reportingCtx()
    await expect(dispatch("task.report", { taskId: "t1", outcome: "done" }, ctx)).rejects.toThrow(
      "outcome must be succeeded or failed",
    )
    await expect(dispatch("task.report", { taskId: "t1" }, ctx)).rejects.toThrow("outcome is required")
    expect(stored).toEqual([])
  })

  it("resolves the task from cwd by worktree path when taskId is absent", async () => {
    const { ctx, stored } = reportingCtx([{ id: "wt", worktreePath: "/repo/.kobe/worktrees/wt" }])
    await dispatch("task.report", { cwd: "/repo/.kobe/worktrees/wt/src", outcome: "succeeded" }, ctx)
    expect(stored.map((s) => s.id)).toEqual(["wt"])
  })

  it("errors loudly when neither taskId nor cwd matches a task", async () => {
    const { ctx, stored } = reportingCtx()
    await expect(dispatch("task.report", { cwd: "/elsewhere", outcome: "failed" }, ctx)).rejects.toThrow(
      "task.report: taskId is required",
    )
    expect(stored).toEqual([])
  })
})
