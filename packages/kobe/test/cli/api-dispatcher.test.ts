/**
 * Dispatcher provenance — the collaboration loop's reply address (issue #21).
 *
 * The contract under test is RECEIVER-side routing, not sender-side success:
 * a create records who dispatched it, a worker's bare `send` must land on
 * that exact tab (then the dispatcher task's live canonical engine, then
 * fail LOUD) — never on a freshly spawned engine that swallows the reply.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { invokeVerb } from "../../src/cli/api-cmd.ts"
import { dispatcherEnvPayload } from "../../src/cli/api/dispatcher.ts"
import { normalizeIndex } from "../../src/orchestrator/index/store-codec.ts"
import { FakeClient, expectApiError, recordingDelivery, stubRuntime, taskFixture } from "./api-handler-fixtures.ts"

const savedTaskId = process.env.KOBE_TASK_ID
const savedTabId = process.env.KOBE_TAB_ID

function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[name]
  } else process.env[name] = saved
}

beforeEach(() => {
  // biome-ignore lint/performance/noDelete: env must fully unset (assigning undefined leaves the string "undefined").
  delete process.env.KOBE_TASK_ID
  // biome-ignore lint/performance/noDelete: env must fully unset (assigning undefined leaves the string "undefined").
  delete process.env.KOBE_TAB_ID
})
afterEach(() => {
  restoreEnv("KOBE_TASK_ID", savedTaskId)
  restoreEnv("KOBE_TAB_ID", savedTabId)
})

describe("dispatcherEnvPayload", () => {
  it("carries both ids, floors a missing tab, and stays empty without a task id", () => {
    expect(dispatcherEnvPayload({ KOBE_TASK_ID: "d1", KOBE_TAB_ID: "tab-4" })).toEqual({
      dispatcherTaskId: "d1",
      dispatcherTabId: "tab-4",
    })
    expect(dispatcherEnvPayload({ KOBE_TASK_ID: "d1" })).toEqual({ dispatcherTaskId: "d1", dispatcherTabId: "tab-1" })
    expect(dispatcherEnvPayload({ KOBE_TAB_ID: "tab-4" })).toEqual({})
    expect(dispatcherEnvPayload({})).toEqual({})
  })
})

describe("create records the dispatcher ($KOBE_TASK_ID/$KOBE_TAB_ID)", () => {
  it("add sends the caller's task + tab to task.create", async () => {
    process.env.KOBE_TASK_ID = "disp-1"
    process.env.KOBE_TAB_ID = "tab-2"
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await invokeVerb("add", ["--repo", "/repo/x"], { client, runtime: stubRuntime() })
    expect(client.requests[0].payload).toEqual({
      repo: "/repo/x",
      dispatcherTaskId: "disp-1",
      dispatcherTabId: "tab-2",
    })
  })

  it("add without $KOBE_TAB_ID floors the tab to the canonical tab-1", async () => {
    process.env.KOBE_TASK_ID = "disp-1"
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await invokeVerb("add", ["--repo", "/repo/x"], { client, runtime: stubRuntime() })
    expect(client.requests[0].payload).toMatchObject({ dispatcherTaskId: "disp-1", dispatcherTabId: "tab-1" })
  })

  it("add from a plain shell records nothing", async () => {
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await invokeVerb("add", ["--repo", "/repo/x"], { client, runtime: stubRuntime() })
    expect(client.requests[0].payload).toEqual({ repo: "/repo/x" })
  })

  it("fan-out records the same dispatcher on every sibling", async () => {
    process.env.KOBE_TASK_ID = "disp-1"
    process.env.KOBE_TAB_ID = "tab-3"
    const client = new FakeClient({
      "task.create": (_payload, i) => ({ taskId: `t${i}`, task: taskFixture({ id: `t${i}` }) }),
    })
    const { deliver } = recordingDelivery()
    await invokeVerb("fan-out", ["--repo", "/repo/x", "--count", "2", "--prompt", "go"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })
    const creates = client.requests.filter((r) => r.name === "task.create")
    expect(creates).toHaveLength(2)
    for (const create of creates) {
      expect(create.payload).toMatchObject({ dispatcherTaskId: "disp-1", dispatcherTabId: "tab-3" })
    }
  })
})

describe("bare send replies to the dispatcher", () => {
  function workerClient(dispatcher: unknown): FakeClient {
    return new FakeClient({
      "task.get": (payload) => {
        const { taskId } = payload as { taskId: string }
        if (taskId === "worker-1") return { task: taskFixture({ id: "worker-1", title: "Worker", dispatcher }) }
        return { task: taskFixture({ id: taskId, title: "Coordinator" }) }
      },
    })
  }

  beforeEach(() => {
    process.env.KOBE_TASK_ID = "worker-1"
    process.env.KOBE_TAB_ID = "tab-9"
  })

  it("lands on the dispatcher's exact tab when it is alive", async () => {
    const client = workerClient({ taskId: "disp-1", tabId: "tab-2" })
    const { calls, deliver } = recordingDelivery()
    await invokeVerb("send", ["--prompt", "succeeded: done"], {
      client,
      runtime: stubRuntime({
        deliverPrompt: deliver,
        taskTabs: async () => ({
          tabs: [{ id: "tab-2", kind: "engine", alive: true } as never],
          running: true,
        }),
      }),
    })
    // Never consults the active task — the dispatcher IS the default target.
    expect(client.subscribeCount).toBe(0)
    expect(calls[0].target).toMatchObject({ id: "disp-1", tab: "tab-2" })
  })

  it("falls back to the dispatcher task's canonical engine when the tab died", async () => {
    const client = workerClient({ taskId: "disp-1", tabId: "tab-2" })
    const { calls, deliver } = recordingDelivery()
    await invokeVerb("send", ["--prompt", "succeeded: done"], {
      client,
      runtime: stubRuntime({
        deliverPrompt: deliver,
        taskTabs: async () => ({
          tabs: [
            { id: "tab-2", kind: "engine", alive: false } as never,
            { id: "tab-3", kind: "engine", alive: true } as never,
          ],
          running: true,
        }),
      }),
    })
    expect(calls[0].target.id).toBe("disp-1")
    expect(calls[0].target.tab).toBeUndefined()
  })

  it("falls back the same way when the dispatcher tab is gone from the join entirely", async () => {
    const client = workerClient({ taskId: "disp-1", tabId: "tab-2" })
    const { calls, deliver } = recordingDelivery()
    await invokeVerb("send", ["--prompt", "succeeded: done"], {
      client,
      runtime: stubRuntime({
        deliverPrompt: deliver,
        taskTabs: async () => ({ tabs: [{ id: "tab-3", kind: "engine", alive: true } as never], running: true }),
      }),
    })
    // An absent tab must not be addressed exactly (TAB_NOT_FOUND at
    // delivery) — the canonical live engine is the next rung down.
    expect(calls[0].target.tab).toBeUndefined()
  })

  it("fails LOUD when the dispatcher task has nothing alive — never a silent spawn", async () => {
    const client = workerClient({ taskId: "disp-1", tabId: "tab-2" })
    const { calls, deliver } = recordingDelivery()
    await expectApiError(
      () =>
        invokeVerb("send", ["--prompt", "succeeded: done"], {
          client,
          runtime: stubRuntime({
            deliverPrompt: deliver,
            taskTabs: async () => ({
              tabs: [{ id: "tab-2", kind: "engine", alive: false } as never],
              running: false,
            }),
          }),
        }),
      "DISPATCHER_UNREACHABLE",
    )
    // The delivery layer is never entered: a dead reply target must not
    // boot a fresh engine that swallows the outcome (issue #19's mode).
    expect(calls).toHaveLength(0)
  })

  it("an explicit --tab keeps exact-tab semantics on the dispatcher task", async () => {
    const client = workerClient({ taskId: "disp-1", tabId: "tab-2" })
    const { calls, deliver } = recordingDelivery()
    const taskTabs = async (): Promise<never> => {
      throw new Error("explicit --tab must not run the fallback chain")
    }
    await invokeVerb("send", ["--tab", "tab-7", "--prompt", "hi"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver, taskTabs }),
    })
    expect(calls[0].target).toMatchObject({ id: "disp-1", tab: "tab-7" })
  })

  it("a task without a dispatcher keeps the active-task default", async () => {
    const client = workerClient(undefined)
    client.replay.push({ channel: "active-task", payload: { taskId: "active-1" } })
    const { calls, deliver } = recordingDelivery()
    await invokeVerb("send", ["--prompt", "hi"], { client, runtime: stubRuntime({ deliverPrompt: deliver }) })
    expect(client.subscribeCount).toBe(1)
    expect(calls[0].target.id).toBe("active-1")
  })

  it("the [KOBE PEER] reply command is tab-precise (sender's $KOBE_TAB_ID)", async () => {
    const client = workerClient({ taskId: "disp-1", tabId: "tab-2" })
    const { calls, deliver } = recordingDelivery()
    await invokeVerb("send", ["--task-id", "disp-1", "--prompt", "hi"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })
    expect(calls[0].prompt).toContain("send --task-id worker-1 --tab tab-9 --prompt")
  })
})

describe("persistence codec", () => {
  function row(over: Record<string, unknown>): Record<string, unknown> {
    return {
      id: "01HXTASKAAAAAAAAAAAAAAAAA",
      title: "T",
      repo: "/repo/x",
      branch: "kobe/t",
      worktreePath: "/wt/t",
      status: "backlog",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...over,
    }
  }

  it("dispatcher survives the load coercion", () => {
    const { tasks } = normalizeIndex(
      { version: 3, tasks: [row({ dispatcher: { taskId: "disp-1", tabId: "tab-2" } })] },
      "test",
    )
    expect(tasks[0].dispatcher).toEqual({ taskId: "disp-1", tabId: "tab-2" })
  })

  it("records without the field (and malformed values) normalize to undefined", () => {
    const { tasks } = normalizeIndex(
      { version: 3, tasks: [row({}), row({ dispatcher: { taskId: "disp-1" } }), row({ dispatcher: "disp-1" })] },
      "test",
    )
    expect(tasks).toHaveLength(3)
    for (const task of tasks) expect(task.dispatcher).toBeUndefined()
  })
})
