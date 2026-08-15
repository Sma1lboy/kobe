/** Request-traffic tests for API collection, lifecycle, adoption, and delivery. */

import { describe, expect, it } from "vitest"
import {
  ApiError,
  type DeliveredPrompt,
  type PromptDeliveryOps,
  type PromptTarget,
  deliverPrompt,
  invokeVerb,
} from "../../src/cli/api-cmd.ts"
import { FakeClient, expectApiError, recordingTearDown, stubRuntime, taskFixture } from "./api-handler-fixtures.ts"

describe("issue handler", () => {
  it("sends a daemon-owned issue mutation", async () => {
    const client = new FakeClient({ "issue.mutate": () => ({ repoRoot: "/repo/x", issues: [] }) })
    await invokeVerb("issue-set-status", ["--repo", "/repo/x", "--id", "8", "--status", "done"], {
      client,
      runtime: stubRuntime(),
    })
    expect(client.requests[0]).toEqual({
      name: "issue.mutate",
      payload: { repoRoot: "/repo/x", op: { type: "setStatus", id: 8, status: "done" } },
    })
  })
})

describe("collect handler", () => {
  it("reads explicit ids and reports hosted liveness plus changes", async () => {
    const client = new FakeClient({
      "task.get": (payload) => ({ task: taskFixture({ id: (payload as { taskId: string }).taskId }) }),
    })
    const result = (await invokeVerb("collect", ["--task-ids", " a , b "], {
      client,
      runtime: stubRuntime({
        taskTabs: async (id) => ({
          tabs: [
            {
              id: "tab-1",
              kind: "engine",
              title: null,
              vendor: null,
              liveVendor: null,
              lastTitle: null,
              autoTitle: null,
              alive: id === "a",
              exit: null,
            },
          ],
          running: id === "a",
        }),
        readWorktreeChanges: async () => ({ added: 2, deleted: 1 }),
      }),
    })) as {
      tasks: Array<{ taskId: string; running: boolean; tabs: Array<{ id: string; alive: boolean }>; changes: unknown }>
    }
    expect(result.tasks.map((task) => [task.taskId, task.running])).toEqual([
      ["a", true],
      ["b", false],
    ])
    // The per-tab join rides along so a coordinator can pick a `send --tab`
    // target without a second get-task hop.
    expect(result.tasks[0].tabs).toEqual([expect.objectContaining({ id: "tab-1", alive: true })])
    expect(result.tasks[0].changes).toEqual({ added: 2, deleted: 1 })
  })

  it("skips changes for a task without a worktree", async () => {
    const client = new FakeClient({ "task.get": () => ({ task: taskFixture({ worktreePath: "" }) }) })
    const result = (await invokeVerb("collect", ["--task-ids", "a"], {
      client,
      runtime: stubRuntime({
        readWorktreeChanges: async () => {
          throw new Error("must not run")
        },
        readBranchSignals: async () => {
          throw new Error("must not run")
        },
      }),
    })) as { tasks: Array<{ changes: unknown; base: unknown }> }
    expect(result.tasks[0].changes).toEqual({ added: 0, deleted: 0 })
    expect(result.tasks[0].base).toEqual({ baseRef: null, ahead: null, diff: null })
  })

  it("reports committed base signals and the task's groupId", async () => {
    const client = new FakeClient({
      "task.get": () => ({ task: taskFixture({ groupId: "g1" }) }),
    })
    const result = (await invokeVerb("collect", ["--task-ids", "a"], {
      client,
      runtime: stubRuntime({
        readBranchSignals: async () => ({
          baseRef: "origin/main",
          ahead: 3,
          diff: { files: 4, insertions: 120, deletions: 8 },
        }),
      }),
    })) as { tasks: Array<{ groupId?: string; base: { baseRef: string | null; ahead: number | null } }> }
    expect(result.tasks[0].groupId).toBe("g1")
    expect(result.tasks[0].base).toEqual({
      baseRef: "origin/main",
      ahead: 3,
      diff: { files: 4, insertions: 120, deletions: 8 },
    })
  })

  it("filters repo collection to unarchived tasks", async () => {
    const client = new FakeClient({
      "task.list": () => ({
        tasks: [
          taskFixture({ id: "in-repo" }),
          taskFixture({ id: "archived", archived: true }),
          taskFixture({ id: "elsewhere", repo: "/repo/y" }),
        ],
      }),
      "task.get": (payload) => ({ task: taskFixture({ id: (payload as { taskId: string }).taskId }) }),
    })
    const result = (await invokeVerb("collect", ["--repo", "/repo/x"], {
      client,
      runtime: stubRuntime(),
    })) as { tasks: Array<{ taskId: string }> }
    expect(result.tasks.map((task) => task.taskId)).toEqual(["in-repo"])
  })

  it("requires ids or repo", async () => {
    await expectApiError(
      () => invokeVerb("collect", [], { client: new FakeClient(), runtime: stubRuntime() }),
      "MISSING_TARGET",
    )
  })
})

describe("task lifecycle handlers", () => {
  it("pairs get-task with tab liveness — running + per-tab alive from one read", async () => {
    const task = taskFixture()
    const client = new FakeClient({ "task.get": () => ({ task }) })
    // The issue-#5 shape: canonical tab-1 dead, a later engine tab alive —
    // running must be true and the tabs array must say which tab to target.
    const tabs = [
      {
        id: "tab-1",
        kind: "engine",
        title: null,
        vendor: null,
        liveVendor: null,
        lastTitle: null,
        autoTitle: null,
        alive: false,
        exit: { code: 1, signal: null, at: "2026-08-11T00:00:00.000Z" },
      },
      {
        id: "tab-2",
        kind: "engine",
        title: null,
        vendor: null,
        liveVendor: "claude",
        lastTitle: "wiring tests",
        autoTitle: null,
        alive: true,
        exit: null,
      },
    ] as const
    const result = await invokeVerb("get-task", ["--task-id", "t1"], {
      client,
      runtime: stubRuntime({ taskTabs: async () => ({ tabs, running: true }) }),
    })
    expect(result).toEqual({ task, running: true, tabs })
  })

  it("land --remove-worktree sends the caller's cwd so the daemon can refuse self-removal", async () => {
    const client = new FakeClient({
      "task.land": () => ({ result: { branch: "b", strategy: "merge", landedOn: "main", commit: "abc" } }),
    })
    await invokeVerb("land", ["--task-id", "t1", "--remove-worktree"], { client, runtime: stubRuntime() })
    const payload = client.requests[0]?.payload as { removeWorktree?: boolean; callerCwd?: string }
    expect(payload.removeWorktree).toBe(true)
    expect(payload.callerCwd).toBe(process.cwd())
  })

  it("plain land does not leak a callerCwd", async () => {
    const client = new FakeClient({
      "task.land": () => ({ result: { branch: "b", strategy: "merge", landedOn: "main", commit: "abc" } }),
    })
    await invokeVerb("land", ["--task-id", "t1"], { client, runtime: stubRuntime() })
    const payload = client.requests[0]?.payload as { removeWorktree?: boolean; callerCwd?: string }
    expect(payload.removeWorktree).toBe(false)
    expect(payload.callerCwd).toBeUndefined()
  })

  it("sets and clears active task", async () => {
    const client = new FakeClient({ "task.setActive": () => ({}) })
    await invokeVerb("set-active", ["--task-id", "t1"], { client, runtime: stubRuntime() })
    await invokeVerb("set-active", ["--none"], { client, runtime: stubRuntime() })
    expect(client.requests.map((request) => request.payload)).toEqual([{ taskId: "t1" }, { taskId: null }])
  })

  it("archives before stopping hosted sessions", async () => {
    const order: string[] = []
    const client = new FakeClient({
      "task.archive": () => {
        order.push("rpc")
        return {}
      },
    })
    const { killed, tearDownSession } = recordingTearDown()
    await invokeVerb("archive", ["--task-id", "t1"], {
      client,
      runtime: stubRuntime({
        tearDownSession: async (id) => {
          order.push("kill")
          await tearDownSession(id)
        },
      }),
    })
    expect(killed).toEqual(["t1"])
    expect(order).toEqual(["rpc", "kill"])
  })

  it("does not stop sessions when unarchiving", async () => {
    const client = new FakeClient({ "task.archive": () => ({}) })
    const { killed, tearDownSession } = recordingTearDown()
    await invokeVerb("archive", ["--task-id", "t1", "--archived=false"], {
      client,
      runtime: stubRuntime({ tearDownSession }),
    })
    expect(killed).toEqual([])
  })

  it("deletes before stopping orphaned hosted sessions", async () => {
    const order: string[] = []
    const client = new FakeClient({
      "task.delete": () => {
        order.push("rpc")
        return {}
      },
    })
    const { killed, tearDownSession } = recordingTearDown()
    await invokeVerb("delete", ["--task-id", "t1", "--force"], {
      client,
      runtime: stubRuntime({
        tearDownSession: async (id) => {
          order.push("kill")
          await tearDownSession(id)
        },
      }),
    })
    expect(killed).toEqual(["t1"])
    expect(order).toEqual(["rpc", "kill"])
  })

  it("does not stop hosted sessions when the delete RPC is refused (dirty worktree)", async () => {
    // Non-force delete of a dirty worktree: the daemon's preflight rejects
    // the RPC, so the CLI-side session teardown (which runs AFTER the RPC)
    // must never fire — the session stays alive alongside the surviving
    // worktree instead of the worst-of-both dead-session/live-worktree state.
    const client = new FakeClient({
      "task.delete": () => {
        throw new Error("refused: DIRTY_WORKTREE")
      },
    })
    const { killed, tearDownSession } = recordingTearDown()
    await expect(
      invokeVerb("delete", ["--task-id", "t1"], { client, runtime: stubRuntime({ tearDownSession }) }),
    ).rejects.toThrow("DIRTY_WORKTREE")
    expect(killed).toEqual([])
  })
})

describe("adopt handler", () => {
  it("sends required repo and worktree paths", async () => {
    const client = new FakeClient({ "worktree.adopt": () => ({ task: taskFixture() }) })
    await invokeVerb("adopt", ["--repo", "/repo/x", "--worktree", "/wt/z"], {
      client,
      runtime: stubRuntime(),
    })
    expect(client.requests[0].payload).toEqual({ repo: "/repo/x", worktreePath: "/wt/z" })
  })

  it("includes optional branch, vendor, and title", async () => {
    const client = new FakeClient({ "worktree.adopt": () => ({ task: taskFixture() }) })
    await invokeVerb(
      "adopt",
      ["--repo", "/repo/x", "--worktree", "/wt/z", "--branch", "b1", "--vendor", "codex", "--title", "Adopted"],
      { client, runtime: stubRuntime() },
    )
    expect(client.requests[0].payload).toEqual({
      repo: "/repo/x",
      worktreePath: "/wt/z",
      branch: "b1",
      vendor: "codex",
      title: "Adopted",
    })
  })
})

describe("deliverPrompt", () => {
  function fakeOps(overrides: Partial<PromptDeliveryOps> = {}) {
    const calls: Array<{ target: PromptTarget; worktree: string; prompt: string }> = []
    const ops: PromptDeliveryOps = {
      deliverHosted: async (target, worktree, prompt) => {
        calls.push({ target, worktree, prompt })
        return {
          session: `${target.id}::tab-1`,
          pane: `${target.id}::tab-1`,
          started: true,
          engineReady: true,
          delivered: true,
        }
      },
      ...overrides,
    }
    return { ops, calls }
  }

  const target: PromptTarget = { id: "t1", worktreePath: "/wt/t1", vendor: "claude", repo: "/repo/x" }

  it("routes through the Hosted PTY seam", async () => {
    const { ops, calls } = fakeOps()
    const result = await deliverPrompt(new FakeClient(), target, "hello", ops)
    expect(calls).toEqual([{ target, worktree: "/wt/t1", prompt: "hello" }])
    expect(result).toMatchObject({ session: "t1::tab-1", delivered: true })
  })

  it("materializes a missing worktree first", async () => {
    const client = new FakeClient({ "task.ensureWorktree": () => ({ worktreePath: "/wt/made" }) })
    const { ops, calls } = fakeOps()
    await deliverPrompt(client, { ...target, worktreePath: "" }, "hello", ops)
    expect(calls[0].worktree).toBe("/wt/made")
  })

  it("fails when worktree materialization yields nothing", async () => {
    const client = new FakeClient({ "task.ensureWorktree": () => ({ worktreePath: "" }) })
    const { ops } = fakeOps()
    await expectApiError(() => deliverPrompt(client, { ...target, worktreePath: "" }, "hello", ops), "NO_WORKTREE")
  })

  it("returns a Hosted PTY delivery failure without fallback", async () => {
    const failed: DeliveredPrompt = {
      session: "t1::tab-1",
      pane: "t1::tab-1",
      started: false,
      engineReady: false,
      delivered: false,
    }
    const { ops } = fakeOps({ deliverHosted: async () => failed })
    expect(await deliverPrompt(new FakeClient(), target, "hello", ops)).toEqual(failed)
  })

  it("propagates PTY Host startup failures", async () => {
    const { ops } = fakeOps({
      deliverHosted: async () => {
        throw new ApiError("host failed", "SESSION_FAILED")
      },
    })
    await expectApiError(() => deliverPrompt(new FakeClient(), target, "hello", ops), "SESSION_FAILED")
  })
})
