/** Request-traffic tests for API creation (single + parallel) and send handlers. */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ApiError, type ApiRuntime, invokeVerb } from "../../src/cli/api-cmd.ts"
import { FakeClient, expectApiError, recordingDelivery, stubRuntime, taskFixture } from "./api-handler-fixtures.ts"

// Peer provenance AND dispatcher provenance both key off the caller's own
// $KOBE_TASK_ID/$KOBE_TAB_ID — unset them file-wide so exact-payload
// assertions stay deterministic when the runner itself lives inside a kobe
// task. Tests that WANT provenance set them in their own beforeEach.
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

  it("canonicalizes repo and uses the configured default engine", async () => {
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await invokeVerb("add", ["--repo", "/repo/x/worktree"], {
      client,
      runtime: stubRuntime({ resolveRepoRoot: async () => "/repo/x", defaultVendor: async () => "codex" }),
    })
    // The default engine is a preset id, so it lands in BOTH fields: the raw
    // command to launch and the protocol it speaks.
    expect(client.requests[0].payload).toEqual({ repo: "/repo/x", command: "codex", vendor: "codex" })
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

  it("passes branch, base branch, and command to creation", async () => {
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await invokeVerb(
      "add",
      ["--repo", "/repo/x", "--branch", "feat/x", "--base-branch", "main", "--command", "codex"],
      {
        client,
        runtime: stubRuntime(),
      },
    )
    expect(client.requests[0].payload).toEqual({
      repo: "/repo/x",
      branch: "feat/x",
      baseRef: "main",
      command: "codex",
      vendor: "codex",
    })
  })

  it("records a RAW command line verbatim with its resolved protocol", async () => {
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await invokeVerb("add", ["--repo", "/repo/x", "--command", "codex --search"], {
      client,
      runtime: stubRuntime(),
    })
    // The command is whatever the caller typed; the protocol is derived from
    // its argv[0], never declared alongside it.
    expect(client.requests[0].payload).toEqual({ repo: "/repo/x", command: "codex --search", vendor: "codex" })
  })

  it("records the generic protocol for a command naming no known engine", async () => {
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await invokeVerb("add", ["--repo", "/repo/x", "--command", "my-wrapper --go"], {
      client,
      runtime: stubRuntime(),
    })
    expect(client.requests[0].payload).toEqual({ repo: "/repo/x", command: "my-wrapper --go", vendor: "generic" })
  })

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
    // newTask marks this as a fresh worktree task's FIRST prompt — the
    // delivery layer appends the branch-rename coda for it (issue #8).
    expect(calls[0]).toMatchObject({
      target: { id: "t1", vendor: "codex", modelEffort: "high", newTask: true },
      prompt: "do it",
    })
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
    // send targets an EXISTING task — never flagged as a new-task first
    // prompt, so the branch-rename coda can't reach it (issue #8).
    expect(calls[0].target.newTask).toBeUndefined()
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

  it("threads --tab through to the delivery target", async () => {
    const client = new FakeClient({ "task.get": () => ({ task: taskFixture({ id: "abc" }) }) })
    const { calls, deliver } = recordingDelivery()
    await invokeVerb("send", ["--task-id", "abc", "--prompt", "hi", "--tab", "new"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })
    expect(calls[0].target.tab).toBe("new")
    await invokeVerb("send", ["--task-id", "abc", "--prompt", "hi", "--tab", "tab-3"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })
    expect(calls[1].target.tab).toBe("tab-3")
  })

  it("a new tab can run a DIFFERENT engine than the task (two agents, one worktree)", async () => {
    const client = new FakeClient({ "task.get": () => ({ task: taskFixture({ id: "abc", vendor: "claude" }) }) })
    const { calls, deliver } = recordingDelivery()
    await invokeVerb("send", ["--task-id", "abc", "--prompt", "hi", "--tab", "new", "--command", "codex"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })
    // The delivery runs codex and the tab records it (command + its resolved
    // protocol), while the TASK's own engine is untouched — a second agent in
    // the worktree is not a switch.
    expect(calls[0].target).toMatchObject({ tabCommand: "codex", tabVendor: "codex" })
    expect(client.requests.some((r) => r.name === "task.setCommand")).toBe(false)
  })

  it("refuses --command without --tab new instead of silently running the task's engine", async () => {
    const client = new FakeClient({ "task.get": () => ({ task: taskFixture({ id: "abc" }) }) })
    await expectApiError(
      () =>
        invokeVerb("send", ["--task-id", "abc", "--prompt", "hi", "--tab", "tab-3", "--command", "codex"], {
          client,
          runtime: stubRuntime(),
        }),
      "BAD_FLAG",
    )
  })

  it("rejects a malformed --tab before any delivery", async () => {
    const client = new FakeClient({ "task.get": () => ({ task: taskFixture({ id: "abc" }) }) })
    await expectApiError(
      () =>
        invokeVerb("send", ["--task-id", "abc", "--prompt", "hi", "--tab", "3"], {
          client,
          runtime: stubRuntime(),
        }),
      "BAD_TAB",
    )
  })

  describe("peer provenance ($KOBE_TASK_ID)", () => {
    const saved = process.env.KOBE_TASK_ID
    beforeEach(() => {
      process.env.KOBE_TASK_ID = "sender-1"
    })
    afterEach(() => {
      if (saved === undefined) {
        // biome-ignore lint/performance/noDelete: env must fully unset (assigning undefined leaves the string "undefined").
        delete process.env.KOBE_TASK_ID
      } else process.env.KOBE_TASK_ID = saved
    })

    const peerClient = () =>
      new FakeClient({
        "task.get": (payload) => {
          const id = (payload as { taskId: string }).taskId
          return { task: taskFixture({ id, title: id === "sender-1" ? "Auth attempt" : "T" }) }
        },
      })

    it("prefixes cross-task sends with sender identity and a reply command", async () => {
      const { calls, deliver } = recordingDelivery()
      await invokeVerb("send", ["--task-id", "abc", "--prompt", "hi"], {
        client: peerClient(),
        runtime: stubRuntime({ deliverPrompt: deliver }),
      })
      expect(calls[0].prompt).toContain('[KOBE PEER] from "Auth attempt" (task sender-1')
      expect(calls[0].prompt).toContain("registered as /rove; legacy /kobe installs still work")
      expect(calls[0].prompt).toContain("send --task-id sender-1")
      // The self-teach pointer: a receiver that has never seen kobe learns
      // where the rest of the coordination verbs live.
      expect(calls[0].prompt).toContain("Rove agent skill")
      expect(calls[0].prompt).toMatch(/: hi$/)
    })

    it("--plain sends verbatim", async () => {
      const { calls, deliver } = recordingDelivery()
      await invokeVerb("send", ["--task-id", "abc", "--prompt", "hi", "--plain"], {
        client: peerClient(),
        runtime: stubRuntime({ deliverPrompt: deliver }),
      })
      expect(calls[0].prompt).toBe("hi")
    })

    it("a send to yourself stays untouched", async () => {
      const { calls, deliver } = recordingDelivery()
      await invokeVerb("send", ["--task-id", "sender-1", "--prompt", "hi"], {
        client: peerClient(),
        runtime: stubRuntime({ deliverPrompt: deliver }),
      })
      expect(calls[0].prompt).toBe("hi")
    })

    it("a stale sender id degrades to id-only provenance, never a failed send", async () => {
      const client = new FakeClient({
        "task.get": (payload) => {
          const id = (payload as { taskId: string }).taskId
          if (id === "sender-1") throw new ApiError("task not found", "RPC_ERROR")
          return { task: taskFixture({ id }) }
        },
      })
      const { calls, deliver } = recordingDelivery()
      await invokeVerb("send", ["--task-id", "abc", "--prompt", "hi"], {
        client,
        runtime: stubRuntime({ deliverPrompt: deliver }),
      })
      expect(calls[0].prompt).toContain('from "sender-1" (task sender-1')
    })

    it("a send from outside any kobe task stays untouched", async () => {
      // biome-ignore lint/performance/noDelete: env must fully unset (assigning undefined leaves the string "undefined").
      delete process.env.KOBE_TASK_ID
      const { calls, deliver } = recordingDelivery()
      await invokeVerb("send", ["--task-id", "abc", "--prompt", "hi"], {
        client: peerClient(),
        runtime: stubRuntime({ deliverPrompt: deliver }),
      })
      expect(calls[0].prompt).toBe("hi")
    })
  })
})

describe("add --count (parallel round)", () => {
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
