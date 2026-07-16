/** Request-traffic tests for API creation, send, and fan-out handlers. */

import { describe, expect, it } from "vitest"
import { ApiError, type ApiRuntime, invokeVerb } from "../../src/cli/api-cmd.ts"
import { FakeClient, expectApiError, recordingDelivery, stubRuntime, taskFixture } from "./api-handler-fixtures.ts"

describe("add handler", () => {
  it("creates without stealing focus", async () => {
    const task = taskFixture()
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task }) })
    const result = await invokeVerb("add", ["--repo", "/repo/x"], { client, runtime: stubRuntime() })
    expect(client.requestNames).toEqual(["task.create"])
    expect(client.requests[0].payload).toEqual({ repo: "/repo/x" })
    expect(result).toEqual({ taskId: "t1", task, started: false })
  })

  it("sets active only when requested", async () => {
    const client = new FakeClient({
      "task.create": () => ({ taskId: "t1", task: taskFixture() }),
      "task.setActive": () => ({}),
    })
    await invokeVerb("add", ["--repo", "/repo/x", "--activate"], { client, runtime: stubRuntime() })
    expect(client.requestNames).toEqual(["task.create", "task.setActive"])
    expect(client.requests[1].payload).toEqual({ taskId: "t1" })
  })

  it("canonicalizes repo and uses the configured default vendor", async () => {
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await invokeVerb("add", ["--repo", "/repo/x/worktree"], {
      client,
      runtime: stubRuntime({ resolveRepoRoot: async () => "/repo/x", defaultVendor: async () => "codex" }),
    })
    expect(client.requests[0].payload).toEqual({ repo: "/repo/x", vendor: "codex" })
  })

  it("applies status and pin then returns the refreshed task", async () => {
    const fresh = taskFixture({ status: "in_progress", pinned: true })
    const client = new FakeClient({
      "task.create": () => ({ taskId: "t1", task: taskFixture() }),
      "task.status": () => ({}),
      "task.pin": () => ({}),
      "task.get": () => ({ task: fresh }),
    })
    const result = (await invokeVerb(
      "add",
      ["--repo", "/repo/x", "--status", "in_progress", "--pin", "--title", "My task"],
      { client, runtime: stubRuntime() },
    )) as { task: unknown }
    expect(client.requestNames).toEqual(["task.create", "task.status", "task.pin", "task.get"])
    expect(result.task).toEqual(fresh)
  })

  it("passes branch, base branch, and vendor to creation", async () => {
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await invokeVerb("add", ["--repo", "/repo/x", "--branch", "feat/x", "--base-branch", "main", "--vendor", "codex"], {
      client,
      runtime: stubRuntime(),
    })
    expect(client.requests[0].payload).toEqual({ repo: "/repo/x", branch: "feat/x", baseRef: "main", vendor: "codex" })
  })

  it("delivers an explicit prompt to the created task", async () => {
    const task = taskFixture({ kind: "task", vendor: "codex", modelEffort: "high" })
    const client = new FakeClient({
      "task.create": () => ({ taskId: "t1", task }),
      "task.get": () => ({ task }),
    })
    const { calls, deliver } = recordingDelivery()
    const result = (await invokeVerb("add", ["--repo", "/repo/x", "--prompt", "do it"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })) as Record<string, unknown>
    expect(calls[0]).toMatchObject({ target: { id: "t1", vendor: "codex", modelEffort: "high" }, prompt: "do it" })
    expect(result).toMatchObject({ started: true, engineReady: true, delivered: true, session: "t1::tab-1" })
  })

  it("keeps the spawn-task alias", async () => {
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    const result = (await invokeVerb("spawn-task", ["--repo", "/repo/x"], {
      client,
      runtime: stubRuntime(),
    })) as { taskId: string }
    expect(result.taskId).toBe("t1")
  })
})

describe("send handler", () => {
  it("uses an explicit target without consulting active task", async () => {
    const client = new FakeClient({ "task.get": () => ({ task: taskFixture({ id: "abc" }) }) })
    const { calls, deliver } = recordingDelivery()
    const result = await invokeVerb("send", ["--task-id", "abc", "--prompt", "hi"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })
    expect(client.subscribeCount).toBe(0)
    expect(calls[0].prompt).toBe("hi")
    expect(result).toMatchObject({ ok: true, taskId: "abc", started: true })
  })

  it("falls back to the daemon active task", async () => {
    const client = new FakeClient({ "task.get": () => ({ task: taskFixture({ id: "active-1" }) }) })
    client.replay.push({ channel: "active-task", payload: { taskId: "active-1" } })
    const { calls, deliver } = recordingDelivery()
    await invokeVerb("send", ["--prompt", "hi"], { client, runtime: stubRuntime({ deliverPrompt: deliver }) })
    expect(client.subscribeCount).toBe(1)
    expect(calls[0].target.id).toBe("active-1")
  })

  it("reports a prompt that did not land", async () => {
    const client = new FakeClient({ "task.get": () => ({ task: taskFixture() }) })
    await expectApiError(
      () =>
        invokeVerb("send", ["--task-id", "t1", "--prompt", "hi"], {
          client,
          runtime: stubRuntime({ deliverPrompt: recordingDelivery({ delivered: false }).deliver }),
        }),
      "NOT_DELIVERED",
    )
  })

  it("requires an explicit or active target", async () => {
    await expectApiError(
      () => invokeVerb("send", ["--prompt", "hi"], { client: new FakeClient(), runtime: stubRuntime() }),
      "MISSING_TARGET",
    )
  })
})

describe("fan-out handler", () => {
  const fanClient = () =>
    new FakeClient({
      "task.create": (_payload, index) => ({ taskId: `t${index + 1}`, task: taskFixture({ id: `t${index + 1}` }) }),
    })

  it("creates and delivers the requested count", async () => {
    const client = fanClient()
    const { calls, deliver } = recordingDelivery()
    const result = (await invokeVerb("fan-out", ["--repo", "/repo/x", "--prompt", "go", "--count", "3"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })) as { count: number; tasks: Array<{ taskId: string }> }
    expect(result.count).toBe(3)
    expect(result.tasks.map((task) => task.taskId)).toEqual(["t1", "t2", "t3"])
    expect(calls.map((call) => call.prompt)).toEqual(["go", "go", "go"])
  })

  it("expands per-vendor agent counts in order", async () => {
    const { calls, deliver } = recordingDelivery()
    await invokeVerb("fan-out", ["--repo", "/repo/x", "--prompt", "go", "--agents", "claude:2,codex:1"], {
      client: fanClient(),
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })
    expect(calls.map((call) => call.target.vendor)).toEqual(["claude", "claude", "codex"])
  })

  it("rejects a plan above the cap before creation", async () => {
    const client = fanClient()
    await expectApiError(
      () =>
        invokeVerb("fan-out", ["--repo", "/repo/x", "--prompt", "go", "--count", "11"], {
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
      "fan-out",
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
    await invokeVerb("fan-out", ["--repo", "/repo/x", "--prompt", "go", "--count", "1", "--title", "solo"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })
    await invokeVerb("fan-out", ["--repo", "/repo/x", "--prompt", "go", "--count", "2"], {
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
      await invokeVerb("fan-out", ["--repo", "/repo/x", "--prompt", "go", "--count", "3"], {
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
      await invokeVerb("fan-out", ["--repo", "/repo/x", "--prompt", "go", "--count", "3"], {
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
