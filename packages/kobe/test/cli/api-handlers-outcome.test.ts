/**
 * Supervision-verb tests (`report` / `await`) — the honest completion
 * contract. Pins: `report` targets $KOBE_TASK_ID then the cwd, `await`
 * settles ONLY on explicit worker reports (or missing tasks) and returns a
 * `timedOut: true` CHECKPOINT with exit-0 semantics instead of failing.
 */

import { afterEach, describe, expect, it } from "vitest"
import { invokeVerb } from "../../src/cli/api-cmd.ts"
import { FakeClient, stubRuntime, taskFixture } from "./api-handler-fixtures.ts"

const runtime = stubRuntime()

function reportedTask(id: string, outcome: "succeeded" | "failed", summary?: string): Record<string, unknown> {
  return taskFixture({
    id,
    workerReport: { outcome, ...(summary ? { summary } : {}), reportedAt: "2026-07-27T00:00:00.000Z" },
  })
}

describe("report handler", () => {
  const savedEnvTaskId = process.env.KOBE_TASK_ID
  afterEach(() => {
    if (savedEnvTaskId === undefined) {
      // biome-ignore lint/performance/noDelete: env must fully unset when it was unset pre-test (assigning undefined leaves the string "undefined").
      delete process.env.KOBE_TASK_ID
    } else process.env.KOBE_TASK_ID = savedEnvTaskId
  })

  it("sends an explicit outcome + summary for --task-id and returns the daemon echo", async () => {
    const client = new FakeClient({
      "task.report": (payload) => ({ taskId: (payload as { taskId: string }).taskId, workerReport: payload }),
    })
    const result = await invokeVerb(
      "report",
      ["--task-id", "t1", "--outcome", "succeeded", "--summary", "tests green"],
      { client, runtime },
    )
    expect(client.requests).toEqual([
      { name: "task.report", payload: { outcome: "succeeded", summary: "tests green", taskId: "t1" } },
    ])
    expect((result as { taskId: string }).taskId).toBe("t1")
  })

  it("falls back to $KOBE_TASK_ID (the engine-tab identity) when --task-id is absent", async () => {
    process.env.KOBE_TASK_ID = "env-task"
    const client = new FakeClient({ "task.report": () => ({}) })
    await invokeVerb("report", ["--outcome", "failed"], { client, runtime })
    expect(client.requests[0].payload).toEqual({ outcome: "failed", taskId: "env-task" })
  })

  it("falls back to the cwd (daemon-side worktree match) when no id is known", async () => {
    // biome-ignore lint/performance/noDelete: the fallback under test only fires when the var is truly unset.
    delete process.env.KOBE_TASK_ID
    const client = new FakeClient({ "task.report": () => ({}) })
    await invokeVerb("report", ["--outcome", "succeeded"], { client, runtime })
    expect(client.requests[0].payload).toEqual({ outcome: "succeeded", cwd: process.cwd() })
  })

  it("rejects a non-explicit outcome at the flag layer", async () => {
    const client = new FakeClient({})
    await expect(invokeVerb("report", ["--task-id", "t1", "--outcome", "done"], { client, runtime })).rejects.toThrow(
      /--outcome must be one of succeeded, failed/,
    )
  })
})

describe("await handler", () => {
  it("resolves from the subscribe-time snapshot replay when every task already reported", async () => {
    const client = new FakeClient({ "task.list": () => ({ tasks: [] }) })
    client.replay.push({
      channel: "task.snapshot",
      payload: { tasks: [reportedTask("a", "succeeded", "did it"), reportedTask("b", "failed")] },
    })
    const result = (await invokeVerb("await", ["--task-ids", "a,b"], { client, runtime })) as {
      timedOut: boolean
      provenance: string
      tasks: Array<Record<string, unknown>>
    }
    expect(result.timedOut).toBe(false)
    expect(result.provenance).toBe("worker report, not kobe-verified")
    expect(result.tasks).toEqual([
      {
        taskId: "a",
        settled: true,
        outcome: "succeeded",
        summary: "did it",
        reportedAt: "2026-07-27T00:00:00.000Z",
        status: "backlog",
      },
      { taskId: "b", settled: true, outcome: "failed", reportedAt: "2026-07-27T00:00:00.000Z", status: "backlog" },
    ])
  })

  it("stays pending on an unreported task, then settles on a later snapshot push — no polling", async () => {
    const client = new FakeClient({ "task.list": () => ({ tasks: [taskFixture({ id: "a" })] }) })
    const pending = invokeVerb("await", ["--task-ids", "a"], { client, runtime }) as Promise<{
      timedOut: boolean
      tasks: Array<{ outcome: string | null }>
    }>
    // Let subscribe + the initial task.list read run: still unsettled.
    await new Promise((r) => setTimeout(r, 10))
    expect(client.requestNames).toEqual(["task.list"])
    client.emit("task.snapshot", { tasks: [reportedTask("a", "succeeded")] } as never)
    const result = await pending
    expect(result.timedOut).toBe(false)
    expect(result.tasks[0].outcome).toBe("succeeded")
  })

  it("a task id that matches nothing settles as missing instead of blocking forever", async () => {
    const client = new FakeClient({ "task.list": () => ({ tasks: [] }) })
    const result = (await invokeVerb("await", ["--task-ids", "ghost"], { client, runtime })) as {
      timedOut: boolean
      tasks: Array<Record<string, unknown>>
    }
    expect(result.timedOut).toBe(false)
    expect(result.tasks).toEqual([{ taskId: "ghost", settled: true, outcome: null, missing: true }])
  })

  it("times out into a checkpoint (timedOut: true, unsettled rows intact), never an error", async () => {
    const client = new FakeClient({ "task.list": () => ({ tasks: [taskFixture({ id: "a", status: "in_progress" })] }) })
    const result = (await invokeVerb("await", ["--task-ids", "a", "--timeout-secs", "1"], {
      client,
      runtime,
    })) as { timedOut: boolean; tasks: Array<Record<string, unknown>> }
    expect(result.timedOut).toBe(true)
    expect(result.tasks).toEqual([{ taskId: "a", settled: false, outcome: null, status: "in_progress" }])
  })

  it("subscribes as a non-holding pane consumer on the task.snapshot channel only", async () => {
    let subscribeOpts: unknown
    const client = new (class extends FakeClient {
      override async subscribe(opts?: unknown): Promise<unknown> {
        subscribeOpts = opts
        return super.subscribe()
      }
    })({ "task.list": () => ({ tasks: [] }) })
    await invokeVerb("await", ["--task-ids", "ghost"], { client, runtime })
    expect(subscribeOpts).toEqual({ channels: ["task.snapshot"], role: "pane" })
  })
})
