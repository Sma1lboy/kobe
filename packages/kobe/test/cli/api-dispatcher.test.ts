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
import {
  type SelfSessionProbe,
  dispatcherEnvPayload,
  resetVerifiedSelfSession,
  takeIdentityWarning,
  verifiedSelfSession,
} from "../../src/cli/api/dispatcher.ts"
import { normalizeIndex } from "../../src/orchestrator/index/store-codec.ts"
import { FakeClient, expectApiError, recordingDelivery, stubRuntime, taskFixture } from "./api-handler-fixtures.ts"

const savedTaskId = process.env.KOBE_TASK_ID
const savedTabId = process.env.KOBE_TAB_ID

function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[name]
  } else process.env[name] = saved
}

/**
 * A pty host + process tree where THIS process (pid 500) descends from the
 * session's shell — the shape a real `kobe api` call inside an engine tab
 * has: tab shell → engine → its Bash tool → this CLI.
 */
function probeFor(
  key: string,
  opts: { shellPid?: number; alive?: boolean; detached?: boolean } = {},
): SelfSessionProbe {
  const shellPid = opts.shellPid ?? 100
  return {
    pid: 500,
    sessions: async () => [{ key, pid: shellPid, alive: opts.alive ?? true }],
    ps: async () =>
      [
        `  ${shellPid}     1 /bin/zsh -il`,
        `  200 ${opts.detached ? 1 : shellPid} claude`,
        "  500   200 bun kobe api add",
      ].join("\n"),
  }
}

beforeEach(() => {
  resetVerifiedSelfSession()
  takeIdentityWarning()
  // biome-ignore lint/performance/noDelete: env must fully unset (assigning undefined leaves the string "undefined").
  delete process.env.KOBE_TASK_ID
  // biome-ignore lint/performance/noDelete: env must fully unset (assigning undefined leaves the string "undefined").
  delete process.env.KOBE_TAB_ID
})
afterEach(() => {
  resetVerifiedSelfSession()
  restoreEnv("KOBE_TASK_ID", savedTaskId)
  restoreEnv("KOBE_TAB_ID", savedTabId)
})

describe("verifiedSelfSession (issue #24: env identity is inheritable, so it must be proven)", () => {
  it("accepts the env when the named tab is alive AND owns this process", async () => {
    expect(await verifiedSelfSession({ KOBE_TASK_ID: "d1", KOBE_TAB_ID: "tab-4" }, probeFor("d1::tab-4"))).toEqual({
      taskId: "d1",
      tabId: "tab-4",
    })
  })

  it("floors a missing tab id to the canonical tab-1 and verifies THAT", async () => {
    expect(await verifiedSelfSession({ KOBE_TASK_ID: "d1" }, probeFor("d1::tab-1"))).toEqual({
      taskId: "d1",
      tabId: "tab-1",
    })
  })

  it("REFUSES an inherited env: a detached background process no longer descends from the tab", async () => {
    // The incident shape: a Claude Code background daemon forked out of
    // boccha's tab-1, reparented to init, and kept exporting boccha's ids.
    // The session is still perfectly alive — only the lineage is broken.
    expect(
      await verifiedSelfSession(
        { KOBE_TASK_ID: "boccha", KOBE_TAB_ID: "tab-1" },
        probeFor("boccha::tab-1", { detached: true }),
      ),
    ).toBeNull()
    // The degrade is never silent — it rides the verb's JSON result.
    expect(takeIdentityWarning()).toContain("not running inside that tab")
  })

  it("REFUSES when the named session is dead, absent, or the host is gone", async () => {
    const env = { KOBE_TASK_ID: "d1", KOBE_TAB_ID: "tab-1" }
    expect(await verifiedSelfSession(env, probeFor("d1::tab-1", { alive: false }))).toBeNull()
    expect(await verifiedSelfSession(env, probeFor("other::tab-1"))).toBeNull()
    expect(await verifiedSelfSession(env, { ...probeFor("d1::tab-1"), sessions: async () => [] })).toBeNull()
  })

  it("REFUSES when the process tree is unreadable — unverifiable is never trusted", async () => {
    const probe: SelfSessionProbe = {
      ...probeFor("d1::tab-1"),
      ps: async () => {
        throw new Error("ps failed")
      },
    }
    expect(await verifiedSelfSession({ KOBE_TASK_ID: "d1" }, probe)).toBeNull()
  })

  it("the warning is read-and-CLEAR, and a verified resolution leaves none behind", async () => {
    await verifiedSelfSession({ KOBE_TASK_ID: "d1" }, probeFor("d1::tab-1", { detached: true }))
    expect(takeIdentityWarning()).toBeTruthy()
    // One notice per degrade: a second read must not re-warn a later verb.
    expect(takeIdentityWarning()).toBeNull()
    await verifiedSelfSession({ KOBE_TASK_ID: "d1" }, probeFor("d1::tab-1", { detached: true }))
    await verifiedSelfSession({ KOBE_TASK_ID: "d1" }, probeFor("d1::tab-1"))
    expect(takeIdentityWarning()).toBeNull()
  })

  it("stays silent (no warning) for a plain shell with no env at all", async () => {
    expect(await verifiedSelfSession({}, probeFor("d1::tab-1"))).toBeNull()
    expect(takeIdentityWarning()).toBeNull()
  })
})

describe("dispatcherEnvPayload", () => {
  it("carries the verified pair, and stays empty when the env can't be proven", async () => {
    expect(await dispatcherEnvPayload({ KOBE_TASK_ID: "d1", KOBE_TAB_ID: "tab-4" }, probeFor("d1::tab-4"))).toEqual({
      dispatcherTaskId: "d1",
      dispatcherTabId: "tab-4",
    })
    expect(await dispatcherEnvPayload({ KOBE_TASK_ID: "d1" }, probeFor("d1::tab-1"))).toEqual({
      dispatcherTaskId: "d1",
      dispatcherTabId: "tab-1",
    })
    expect(await dispatcherEnvPayload({ KOBE_TAB_ID: "tab-4" }, probeFor("d1::tab-1"))).toEqual({})
    expect(await dispatcherEnvPayload({}, probeFor("d1::tab-1"))).toEqual({})
    // The pollution case: real ids, real live tab, wrong process.
    expect(await dispatcherEnvPayload({ KOBE_TASK_ID: "d1" }, probeFor("d1::tab-1", { detached: true }))).toEqual({})
  })
})

/** Prime the verified-identity memo so `invokeVerb` runs no real pty/ps IO. */
async function asSession(taskId: string, tabId: string, opts?: { detached?: boolean }): Promise<void> {
  await verifiedSelfSession({ KOBE_TASK_ID: taskId, KOBE_TAB_ID: tabId }, probeFor(`${taskId}::${tabId}`, opts))
}

describe("create records the dispatcher ($KOBE_TASK_ID/$KOBE_TAB_ID)", () => {
  it("add sends the caller's task + tab to task.create", async () => {
    await asSession("disp-1", "tab-2")
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await invokeVerb("add", ["--repo", "/repo/x"], { client, runtime: stubRuntime() })
    expect(client.requests[0].payload).toEqual({
      repo: "/repo/x",
      dispatcherTaskId: "disp-1",
      dispatcherTabId: "tab-2",
    })
  })

  it("add without $KOBE_TAB_ID floors the tab to the canonical tab-1", async () => {
    await verifiedSelfSession({ KOBE_TASK_ID: "disp-1" }, probeFor("disp-1::tab-1"))
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await invokeVerb("add", ["--repo", "/repo/x"], { client, runtime: stubRuntime() })
    expect(client.requests[0].payload).toMatchObject({ dispatcherTaskId: "disp-1", dispatcherTabId: "tab-1" })
  })

  it("add from a plain shell records nothing", async () => {
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await invokeVerb("add", ["--repo", "/repo/x"], { client, runtime: stubRuntime() })
    expect(client.requests[0].payload).toEqual({ repo: "/repo/x" })
  })

  it("add with an INHERITED env records no dispatcher at all (issue #24)", async () => {
    // Every field is real — boccha's task exists, its tab-1 is alive — but
    // this process was forked out of it days ago and detached. Recording
    // {boccha, tab-1} here is what sent finished workers' reports to a
    // stranger; the honest record is NO record.
    await asSession("boccha", "tab-1", { detached: true })
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await invokeVerb("add", ["--repo", "/repo/x"], { client, runtime: stubRuntime() })
    expect(client.requests[0].payload).toEqual({ repo: "/repo/x" })
  })

  it("a parallel `add --count` round with an inherited env records no dispatcher on any sibling", async () => {
    await asSession("boccha", "tab-1", { detached: true })
    const client = new FakeClient({
      "task.create": (_payload, i) => ({ taskId: `t${i}`, task: taskFixture({ id: `t${i}` }) }),
    })
    const { deliver } = recordingDelivery()
    await invokeVerb("add", ["--repo", "/repo/x", "--count", "2", "--prompt", "go"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })
    for (const create of client.requests.filter((r) => r.name === "task.create")) {
      expect(create.payload).not.toHaveProperty("dispatcherTaskId")
    }
  })

  it("a parallel `add --count` round records the same dispatcher on every sibling", async () => {
    await asSession("disp-1", "tab-3")
    const client = new FakeClient({
      "task.create": (_payload, i) => ({ taskId: `t${i}`, task: taskFixture({ id: `t${i}` }) }),
    })
    const { deliver } = recordingDelivery()
    await invokeVerb("add", ["--repo", "/repo/x", "--count", "2", "--prompt", "go"], {
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

  beforeEach(async () => {
    await asSession("worker-1", "tab-9")
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

  it("an INHERITED env falls back to the active task instead of the stranger's dispatcher", async () => {
    await asSession("worker-1", "tab-9", { detached: true })
    const client = workerClient({ taskId: "disp-1", tabId: "tab-2" })
    client.replay.push({ channel: "active-task", payload: { taskId: "active-1" } })
    const { calls, deliver } = recordingDelivery()
    await invokeVerb("send", ["--prompt", "hi"], { client, runtime: stubRuntime({ deliverPrompt: deliver }) })
    // worker-1's own dispatcher is never even looked up — this process has
    // no proven identity, so it has no reply address to inherit.
    expect(calls[0].target.id).toBe("active-1")
  })

  it("an INHERITED env sends no [KOBE PEER] prefix — impersonation is worse than anonymity", async () => {
    await asSession("worker-1", "tab-9", { detached: true })
    const client = workerClient({ taskId: "disp-1", tabId: "tab-2" })
    const { calls, deliver } = recordingDelivery()
    await invokeVerb("send", ["--task-id", "disp-1", "--prompt", "hi"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })
    expect(calls[0].prompt).toBe("hi")
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
