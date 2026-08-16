/**
 * Request-traffic tests for a PARALLEL `add` round (`--count` / `--agents`).
 *
 * Split out of `api-handlers.test.ts` for the file-size cap: this was the
 * `fan-out` verb's suite, and folding it into `add` (issue #30) kept every
 * rule it pinned — shared groupId, `#i/N` titles, per-sibling failure rows
 * that never orphan a created task — plus the new flag conflicts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ApiError, type ApiRuntime, invokeVerb } from "../../src/cli/api-cmd.ts"
import { FakeClient, expectApiError, recordingDelivery, stubRuntime, taskFixture } from "./api-handler-fixtures.ts"

// Dispatcher provenance keys off the caller's own $KOBE_TASK_ID/$KOBE_TAB_ID —
// unset them file-wide so exact-payload assertions stay deterministic when the
// runner itself lives inside a kobe task (`api-dispatcher.test.ts` owns the
// case where they ARE set).
const savedEnv = { taskId: process.env.KOBE_TASK_ID, tabId: process.env.KOBE_TAB_ID }
beforeEach(() => {
  // biome-ignore lint/performance/noDelete: env must fully unset (assigning undefined leaves the string "undefined").
  delete process.env.KOBE_TASK_ID
  // biome-ignore lint/performance/noDelete: env must fully unset (assigning undefined leaves the string "undefined").
  delete process.env.KOBE_TAB_ID
})
afterEach(() => {
  for (const [name, value] of [
    ["KOBE_TASK_ID", savedEnv.taskId],
    ["KOBE_TAB_ID", savedEnv.tabId],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe("add --count (parallel round)", () => {
  it("refuses --count without a prompt (a parallel round IS its prompt)", async () => {
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await expectApiError(
      () => invokeVerb("add", ["--repo", "/repo/x", "--count", "3"], { client, runtime: stubRuntime() }),
      "MISSING_FLAG",
    )
    expect(client.requests).toEqual([])
  })

  it.each([
    ["--count", ["--count", "2"]],
    ["--command", ["--command", "codex"]],
  ])("refuses %s alongside --agents instead of silently ignoring it", async (_label, extra) => {
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await expectApiError(
      () =>
        invokeVerb("add", ["--repo", "/repo/x", "--prompt", "go", "--agents", "claude:2", ...extra], {
          client,
          runtime: stubRuntime(),
        }),
      "BAD_FLAG",
    )
    // A fleet is expensive to spawn wrong — nothing may be created.
    expect(client.requests).toEqual([])
  })

  it("refuses --branch on a parallel round (siblings cannot share one branch)", async () => {
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await expectApiError(
      () =>
        invokeVerb("add", ["--repo", "/repo/x", "--prompt", "go", "--count", "2", "--branch", "feat/x"], {
          client,
          runtime: stubRuntime(),
        }),
      "BAD_FLAG",
    )
    expect(client.requests).toEqual([])
  })

  const fanClient = () =>
    new FakeClient({
      "task.create": (_payload, index) => ({ taskId: `t${index + 1}`, task: taskFixture({ id: `t${index + 1}` }) }),
    })

  it("creates and delivers the requested count", async () => {
    const client = fanClient()
    const { calls, deliver } = recordingDelivery()
    const result = (await invokeVerb("add", ["--repo", "/repo/x", "--prompt", "go", "--count", "3"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })) as { count: number; tasks: Array<{ taskId: string }> }
    expect(result.count).toBe(3)
    expect(result.tasks.map((task) => task.taskId)).toEqual(["t1", "t2", "t3"])
    expect(calls.map((call) => call.prompt)).toEqual(["go", "go", "go"])
    // Every sibling is a fresh worktree task → first-prompt coda applies.
    expect(calls.every((call) => call.target.newTask === true)).toBe(true)
  })

  it("expands per-vendor agent counts in order", async () => {
    const { calls, deliver } = recordingDelivery()
    await invokeVerb("add", ["--repo", "/repo/x", "--prompt", "go", "--agents", "claude:2,codex:1"], {
      client: fanClient(),
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })
    expect(calls.map((call) => call.target.vendor)).toEqual(["claude", "claude", "codex"])
  })

  it("rejects a plan above the cap before creation", async () => {
    const client = fanClient()
    await expectApiError(
      () =>
        invokeVerb("add", ["--repo", "/repo/x", "--prompt", "go", "--count", "11"], {
          client,
          runtime: stubRuntime(),
        }),
      "BAD_FLAG",
    )
    expect(client.requests).toEqual([])
  })

  it("stamps a shared groupId and #i/N titles on every sibling", async () => {
    const client = fanClient()
    const { deliver } = recordingDelivery()
    const result = (await invokeVerb(
      "add",
      ["--repo", "/repo/x", "--prompt", "go", "--count", "2", "--title", "auth attempt"],
      { client, runtime: stubRuntime({ deliverPrompt: deliver }) },
    )) as { groupId: string }
    const creates = client.requests.filter((r) => r.name === "task.create").map((r) => r.payload) as Array<
      Record<string, string>
    >
    expect(creates).toHaveLength(2)
    expect(creates[0].groupId).toBe(creates[1].groupId)
    expect(creates[0].groupId).toBe(result.groupId)
    expect(creates.map((p) => p.title)).toEqual(["auth attempt #1/2", "auth attempt #2/2"])
  })

  it("leaves a single-task title un-suffixed and titleless siblings placeholder", async () => {
    const client = fanClient()
    const { deliver } = recordingDelivery()
    await invokeVerb("add", ["--repo", "/repo/x", "--prompt", "go", "--count", "1", "--title", "solo"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })
    await invokeVerb("add", ["--repo", "/repo/x", "--prompt", "go", "--count", "2"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })
    const creates = client.requests.filter((r) => r.name === "task.create").map((r) => r.payload) as Array<
      Record<string, string | undefined>
    >
    expect(creates[0].title).toBe("solo")
    // No --title → no title in the payload: the daemon's placeholder +
    // auto-title pass (which appends the group ordinal) owns naming.
    expect(creates[1].title).toBeUndefined()
    expect(creates[2].title).toBeUndefined()
  })

  it("carries already-created taskIds when a mid-loop create fails (no orphans)", async () => {
    const client = new FakeClient({
      "task.create": (_payload, index) => {
        if (index === 2) throw new ApiError("store exploded", "RPC_ERROR")
        return { taskId: `t${index + 1}`, task: taskFixture({ id: `t${index + 1}` }) }
      },
    })
    const { calls, deliver } = recordingDelivery()
    try {
      await invokeVerb("add", ["--repo", "/repo/x", "--prompt", "go", "--count", "3"], {
        client,
        runtime: stubRuntime({ deliverPrompt: deliver }),
      })
      expect.unreachable("should throw")
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).code).toBe("PARTIAL_FANOUT")
      const data = (error as ApiError).data as {
        count: number
        requested: number
        tasks: Array<{ taskId: string }>
        failures: Array<{ taskId?: string; error: { code: string } }>
      }
      // The two tasks created before the failure are real and delivered —
      // their ids MUST reach the caller so a retry doesn't double-spawn.
      expect(data.count).toBe(2)
      expect(data.requested).toBe(3)
      expect(data.tasks.map((t) => t.taskId)).toEqual(["t1", "t2"])
      expect(data.failures).toEqual([
        { ok: false, vendor: "claude", error: { message: "store exploded", code: "RPC_ERROR" } },
      ])
      expect(calls).toHaveLength(2)
    }
  })

  it("reports every id on partial delivery failure", async () => {
    const deliver: ApiRuntime["deliverPrompt"] = async (_client, target) => {
      if (target.id === "t2") throw new ApiError("boom", "SESSION_FAILED")
      return {
        session: `${target.id}::tab-1`,
        pane: `${target.id}::tab-1`,
        started: true,
        engineReady: true,
        delivered: true,
      }
    }
    try {
      await invokeVerb("add", ["--repo", "/repo/x", "--prompt", "go", "--count", "3"], {
        client: fanClient(),
        runtime: stubRuntime({ deliverPrompt: deliver }),
      })
      expect.unreachable("should throw")
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).code).toBe("PARTIAL_FANOUT")
      expect((error as ApiError).data).toMatchObject({
        count: 3,
        tasks: [{ taskId: "t1" }, { taskId: "t3" }],
        failures: [{ taskId: "t2", error: { code: "SESSION_FAILED" } }],
      })
    }
  })
})
