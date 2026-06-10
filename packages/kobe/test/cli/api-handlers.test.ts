/**
 * Unit tests for `kobe api` VERB HANDLER LOGIC — the decisions each handler
 * makes (task resolution, fan-out planning, prompt-delivery choice,
 * create/adopt flag interplay) — driven through `invokeVerb` against a
 * fake daemon client that records requests and a stubbed side-effect
 * runtime. No daemon socket, no tmux server, no git.
 *
 * Why these matter: `kobe api` is scripted against (the kobe skill +
 * shell aliases), so a handler silently changing which RPCs it fires, in
 * what order, with what payload — or what JSON it prints — breaks scripts
 * that never see a type error. These tests pin the REQUEST TRAFFIC and
 * RESULT SHAPES, which the schema (`kobe api schema`) cannot express.
 */

import type { ChannelName, ChannelPayloads } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { describe, expect, it } from "vitest"
import {
  ApiError,
  type ApiRuntime,
  type DeliveredPrompt,
  type PromptDeliveryOps,
  type PromptTarget,
  deliverPrompt,
  invokeVerb,
} from "../../src/cli/api-cmd.ts"
import type { DaemonRpc } from "../../src/cli/daemon-session.ts"
import { tmuxSessionName } from "../../src/tmux/client.ts"
import type { EnsureSessionOpts } from "../../src/tui/panes/terminal/tmux.ts"

// ── Fakes ─────────────────────────────────────────────────────────────────────

type RpcResponder = (payload: unknown, callIndex: number) => unknown

/** Records every request; answers from a per-RPC responder table. */
class FakeClient implements DaemonRpc {
  readonly requests: Array<{ name: string; payload: unknown }> = []
  /** Channel payloads "replayed" when `subscribe()` runs (mirrors the daemon). */
  readonly replay: Array<{ channel: ChannelName; payload: unknown }> = []
  subscribeCount = 0
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>()

  constructor(private readonly responders: Record<string, RpcResponder> = {}) {}

  async request<T = unknown>(name: string, payload?: unknown): Promise<T> {
    const callIndex = this.requests.filter((r) => r.name === name).length
    this.requests.push({ name, payload })
    const respond = this.responders[name]
    if (!respond) throw new Error(`fake daemon has no responder for "${name}"`)
    return respond(payload, callIndex) as T
  }

  async subscribe(): Promise<unknown> {
    this.subscribeCount += 1
    for (const { channel, payload } of this.replay) {
      for (const handler of this.handlers.get(channel) ?? []) handler(payload)
    }
    return {}
  }

  onChannel<C extends ChannelName>(channel: C, handler: (payload: ChannelPayloads[C]) => void): () => void {
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
    }
    const h = handler as (payload: unknown) => void
    set.add(h)
    return () => set?.delete(h)
  }

  get requestNames(): string[] {
    return this.requests.map((r) => r.name)
  }
}

/** A task as the daemon serializes it — only the fields handlers read. */
function taskFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "t1",
    title: "T",
    branch: "kobe/t-t1",
    worktreePath: "/wt/t1",
    vendor: "claude",
    repo: "/repo/x",
    status: "backlog",
    archived: false,
    ...over,
  }
}

/** Runtime whose every operation is inert (or loudly unexpected). */
function stubRuntime(overrides: Partial<ApiRuntime> = {}): ApiRuntime {
  return {
    isTaskRunning: async () => false,
    deliverPrompt: async () => {
      throw new Error("deliverPrompt should not run in this test")
    },
    resolveRepoRoot: async (p) => p,
    readWorktreeChanges: async () => ({ added: 0, deleted: 0 }),
    ...overrides,
  }
}

/** A deliverPrompt that records its calls instead of touching tmux. */
function recordingDelivery(result: Partial<DeliveredPrompt> = {}) {
  const calls: Array<{ target: PromptTarget; prompt: string }> = []
  const deliver: ApiRuntime["deliverPrompt"] = async (_client, target, prompt) => {
    calls.push({ target, prompt })
    return { session: tmuxSessionName(target.id), pane: "%1", started: true, engineReady: true, ...result }
  }
  return { calls, deliver }
}

async function expectApiError(run: () => Promise<unknown>, code: string, message?: string | RegExp): Promise<void> {
  try {
    await run()
    expect.unreachable("should have thrown")
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe(code)
    if (typeof message === "string") expect((err as ApiError).message).toBe(message)
    else if (message) expect((err as ApiError).message).toMatch(message)
  }
}

// ── add: create/flag interplay + prompt decision ─────────────────────────────

describe("add handler", () => {
  it("minimal create: one task.create, no follow-ups, started:false", async () => {
    const task = taskFixture()
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task }) })
    const result = await invokeVerb("add", ["--repo", "/repo/x"], { client, runtime: stubRuntime() })
    expect(client.requestNames).toEqual(["task.create"])
    expect(client.requests[0].payload).toEqual({ repo: "/repo/x" })
    expect(result).toEqual({ taskId: "t1", task, started: false })
  })

  it("resolves a relative --repo against $PWD", async () => {
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await invokeVerb("add", ["--repo", "some/rel"], { client, runtime: stubRuntime() })
    expect((client.requests[0].payload as { repo: string }).repo).toBe(`${process.cwd()}/some/rel`)
  })

  it("applies --status and --pin as follow-up RPCs, then re-reads the task", async () => {
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
    )) as { task: unknown; started: boolean }
    expect(client.requestNames).toEqual(["task.create", "task.status", "task.pin", "task.get"])
    expect(client.requests[0].payload).toEqual({ repo: "/repo/x", title: "My task" })
    expect(client.requests[1].payload).toEqual({ taskId: "t1", status: "in_progress" })
    expect(client.requests[2].payload).toEqual({ taskId: "t1", pinned: true })
    // The returned task is the REFRESHED one, not the create-time snapshot.
    expect(result.task).toEqual(fresh)
  })

  it("--pin=false still fires the follow-up (explicit unpin) and refetches", async () => {
    const client = new FakeClient({
      "task.create": () => ({ taskId: "t1", task: taskFixture() }),
      "task.pin": () => ({}),
      "task.get": () => ({ task: taskFixture() }),
    })
    await invokeVerb("add", ["--repo", "/repo/x", "--pin=false"], { client, runtime: stubRuntime() })
    expect(client.requestNames).toEqual(["task.create", "task.pin", "task.get"])
    expect(client.requests[1].payload).toEqual({ taskId: "t1", pinned: false })
  })

  it("passes branch/base-branch/vendor through to task.create (baseRef key)", async () => {
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    await invokeVerb("add", ["--repo", "/repo/x", "--branch", "feat/x", "--base-branch", "main", "--vendor", "codex"], {
      client,
      runtime: stubRuntime(),
    })
    expect(client.requests[0].payload).toEqual({ repo: "/repo/x", branch: "feat/x", baseRef: "main", vendor: "codex" })
  })

  it("with --prompt it delivers exactly the explicit prompt to the created task", async () => {
    const task = taskFixture({ worktreePath: "/wt/t1", vendor: "codex", repo: "/repo/x" })
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task }) })
    const { calls, deliver } = recordingDelivery()
    const result = (await invokeVerb("add", ["--repo", "/repo/x", "--prompt", "do the thing"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })) as Record<string, unknown>
    expect(calls).toEqual([
      {
        target: { id: "t1", worktreePath: "/wt/t1", vendor: "codex", repo: "/repo/x" },
        prompt: "do the thing",
      },
    ])
    expect(result.started).toBe(true)
    expect(result.engineReady).toBe(true)
    expect(result.session).toBe(tmuxSessionName("t1"))
  })

  it("spawn-task alias dispatches to add", async () => {
    const client = new FakeClient({ "task.create": () => ({ taskId: "t1", task: taskFixture() }) })
    const result = (await invokeVerb("spawn-task", ["--repo", "/repo/x"], {
      client,
      runtime: stubRuntime(),
    })) as { taskId: string }
    expect(result.taskId).toBe("t1")
  })
})

// ── send: task resolution (explicit id vs active task) ──────────────────────

describe("send handler task resolution", () => {
  it("uses an explicit --task-id without consulting the active task", async () => {
    const client = new FakeClient({ "task.get": () => ({ task: taskFixture({ id: "abc" }) }) })
    const { calls, deliver } = recordingDelivery()
    const result = (await invokeVerb("send", ["--task-id", "abc", "--prompt", "hi"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })) as Record<string, unknown>
    expect(client.subscribeCount).toBe(0)
    expect(client.requests[0]).toEqual({ name: "task.get", payload: { taskId: "abc" } })
    expect(calls[0].prompt).toBe("hi")
    expect(result).toMatchObject({ ok: true, taskId: "abc", started: true, engineReady: true })
  })

  it("falls back to the daemon's active task when --task-id is omitted", async () => {
    const client = new FakeClient({ "task.get": () => ({ task: taskFixture({ id: "active-1" }) }) })
    client.replay.push({ channel: "active-task", payload: { taskId: "active-1" } })
    const { calls, deliver } = recordingDelivery()
    const result = (await invokeVerb("send", ["--prompt", "hi"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })) as { taskId: string }
    expect(client.subscribeCount).toBe(1)
    expect(client.requests[0]).toEqual({ name: "task.get", payload: { taskId: "active-1" } })
    expect(calls[0].target.id).toBe("active-1")
    expect(result.taskId).toBe("active-1")
  })

  it("errors with MISSING_TARGET when neither --task-id nor an active task exists", async () => {
    const client = new FakeClient()
    await expectApiError(
      () => invokeVerb("send", ["--prompt", "hi"], { client, runtime: stubRuntime() }),
      "MISSING_TARGET",
      "no --task-id given and no active task — open a task first or pass --task-id",
    )
    // It never fired a task.get / delivery for a target it couldn't resolve.
    expect(client.requestNames).toEqual([])
  })
})

// ── fan-out: plan building, cap, per-task traffic ────────────────────────────

describe("fan-out handler", () => {
  function fanClient(): FakeClient {
    return new FakeClient({
      "task.create": (_payload, i) => ({ taskId: `t${i + 1}`, task: taskFixture({ id: `t${i + 1}` }) }),
    })
  }

  it("--count N spawns N tasks of the default vendor (claude)", async () => {
    const client = fanClient()
    const { calls, deliver } = recordingDelivery()
    const result = (await invokeVerb("fan-out", ["--repo", "/repo/x", "--prompt", "go", "--count", "3"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })) as { count: number; tasks: Array<{ taskId: string; vendor: string }> }
    expect(result.count).toBe(3)
    expect(result.tasks.map((t) => t.taskId)).toEqual(["t1", "t2", "t3"])
    expect(client.requests.filter((r) => r.name === "task.create").map((r) => r.payload)).toEqual([
      { repo: "/repo/x", vendor: "claude" },
      { repo: "/repo/x", vendor: "claude" },
      { repo: "/repo/x", vendor: "claude" },
    ])
    expect(calls.map((c) => c.prompt)).toEqual(["go", "go", "go"])
  })

  it("--agents vendor:count expands in order and overrides --vendor/--count", async () => {
    const client = fanClient()
    const { calls, deliver } = recordingDelivery()
    const result = (await invokeVerb(
      "fan-out",
      ["--repo", "/repo/x", "--prompt", "go", "--agents", "claude:2,codex:1"],
      { client, runtime: stubRuntime({ deliverPrompt: deliver }) },
    )) as { tasks: Array<{ vendor: string }> }
    expect(result.tasks.map((t) => t.vendor)).toEqual(["claude", "claude", "codex"])
    expect(calls.map((c) => c.target.vendor)).toEqual(["claude", "claude", "codex"])
  })

  it("defaults to a single claude task with no --count/--agents", async () => {
    const client = fanClient()
    const { deliver } = recordingDelivery()
    const result = (await invokeVerb("fan-out", ["--repo", "/repo/x", "--prompt", "go"], {
      client,
      runtime: stubRuntime({ deliverPrompt: deliver }),
    })) as { count: number }
    expect(result.count).toBe(1)
  })

  it("rejects a plan above the cap BEFORE creating anything", async () => {
    const client = fanClient()
    await expectApiError(
      () =>
        invokeVerb("fan-out", ["--repo", "/repo/x", "--prompt", "go", "--count", "11"], {
          client,
          runtime: stubRuntime(),
        }),
      "BAD_FLAG",
      "fan-out of 11 exceeds the cap of 10 — spawn in batches",
    )
    expect(client.requestNames).toEqual([])
  })

  it("threads --title and --base-branch into every task.create", async () => {
    const client = fanClient()
    const { deliver } = recordingDelivery()
    await invokeVerb(
      "fan-out",
      [
        "--repo",
        "/repo/x",
        "--prompt",
        "go",
        "--count",
        "2",
        "--vendor",
        "codex",
        "--title",
        "try",
        "--base-branch",
        "main",
      ],
      { client, runtime: stubRuntime({ deliverPrompt: deliver }) },
    )
    expect(client.requests.map((r) => r.payload)).toEqual([
      { repo: "/repo/x", vendor: "codex", title: "try", baseRef: "main" },
      { repo: "/repo/x", vendor: "codex", title: "try", baseRef: "main" },
    ])
  })
})

// ── collect: id-list vs repo-filter resolution ───────────────────────────────

describe("collect handler task resolution", () => {
  it("--task-ids reads each id verbatim (trimmed) and reports liveness + changes", async () => {
    const client = new FakeClient({
      "task.get": (payload) => ({ task: taskFixture({ id: (payload as { taskId: string }).taskId }) }),
    })
    const result = (await invokeVerb("collect", ["--task-ids", " a , b "], {
      client,
      runtime: stubRuntime({
        isTaskRunning: async (taskId) => taskId === "a",
        readWorktreeChanges: async () => ({ added: 2, deleted: 1 }),
      }),
    })) as { tasks: Array<{ taskId: string; running: boolean; changes: unknown }> }
    expect(client.requests.map((r) => r.payload)).toEqual([{ taskId: "a" }, { taskId: "b" }])
    expect(result.tasks.map((t) => [t.taskId, t.running])).toEqual([
      ["a", true],
      ["b", false],
    ])
    expect(result.tasks[0].changes).toEqual({ added: 2, deleted: 1 })
  })

  it("skips the worktree-changes read for a task with no worktree", async () => {
    const client = new FakeClient({ "task.get": () => ({ task: taskFixture({ worktreePath: "" }) }) })
    const result = (await invokeVerb("collect", ["--task-ids", "a"], {
      client,
      runtime: stubRuntime({
        readWorktreeChanges: async () => {
          throw new Error("must not read changes without a worktree")
        },
      }),
    })) as { tasks: Array<{ changes: unknown }> }
    expect(result.tasks[0].changes).toEqual({ added: 0, deleted: 0 })
  })

  it("--repo selects the repo's unarchived tasks via the canonical repo root", async () => {
    const tasks = [
      taskFixture({ id: "in-repo", repo: "/repo/x" }),
      taskFixture({ id: "archived", repo: "/repo/x", archived: true }),
      taskFixture({ id: "elsewhere", repo: "/repo/y" }),
    ]
    const client = new FakeClient({
      "task.list": () => ({ tasks }),
      "task.get": (payload) => ({ task: taskFixture({ id: (payload as { taskId: string }).taskId }) }),
    })
    const result = (await invokeVerb("collect", ["--repo", "/repo/x"], {
      client,
      runtime: stubRuntime(),
    })) as { tasks: Array<{ taskId: string }> }
    expect(result.tasks.map((t) => t.taskId)).toEqual(["in-repo"])
  })

  it("demands a target with MISSING_TARGET when given neither ids nor repo", async () => {
    await expectApiError(
      () => invokeVerb("collect", [], { client: new FakeClient(), runtime: stubRuntime() }),
      "MISSING_TARGET",
      "collect needs --task-ids id1,id2 or --repo PATH",
    )
  })
})

// ── small daemon verbs: payload + result shapes ──────────────────────────────

describe("simple verb handlers", () => {
  it("get-task pairs the daemon task with tmux liveness", async () => {
    const task = taskFixture()
    const client = new FakeClient({ "task.get": () => ({ task }) })
    const result = await invokeVerb("get-task", ["--task-id", "t1"], {
      client,
      runtime: stubRuntime({ isTaskRunning: async () => true }),
    })
    expect(result).toEqual({ task, running: true })
  })

  it("set-active sets a task id, and --none clears it", async () => {
    const client = new FakeClient({ "task.setActive": () => ({}) })
    expect(await invokeVerb("set-active", ["--task-id", "t1"], { client, runtime: stubRuntime() })).toEqual({
      ok: true,
      activeTaskId: "t1",
    })
    expect(await invokeVerb("set-active", ["--none"], { client, runtime: stubRuntime() })).toEqual({
      ok: true,
      activeTaskId: null,
    })
    expect(client.requests.map((r) => r.payload)).toEqual([{ taskId: "t1" }, { taskId: null }])
  })

  it("archive defaults to archived:true; --archived=false unarchives", async () => {
    const client = new FakeClient({ "task.archive": () => ({}) })
    await invokeVerb("archive", ["--task-id", "t1"], { client, runtime: stubRuntime() })
    await invokeVerb("archive", ["--task-id", "t1", "--archived=false"], { client, runtime: stubRuntime() })
    expect(client.requests.map((r) => r.payload)).toEqual([
      { taskId: "t1", archived: true },
      { taskId: "t1", archived: false },
    ])
  })

  it("delete defaults force:false; --force flips it", async () => {
    const client = new FakeClient({ "task.delete": () => ({}) })
    await invokeVerb("delete", ["--task-id", "t1"], { client, runtime: stubRuntime() })
    await invokeVerb("delete", ["--task-id", "t1", "--force"], { client, runtime: stubRuntime() })
    expect(client.requests.map((r) => r.payload)).toEqual([
      { taskId: "t1", force: false },
      { taskId: "t1", force: true },
    ])
  })
})

// ── adopt: flag interplay ────────────────────────────────────────────────────

describe("adopt handler", () => {
  it("sends only repo + worktreePath when optionals are omitted", async () => {
    const client = new FakeClient({ "worktree.adopt": () => ({ task: taskFixture() }) })
    await invokeVerb("adopt", ["--repo", "/repo/x", "--worktree", "/wt/z"], { client, runtime: stubRuntime() })
    expect(client.requests[0].payload).toEqual({ repo: "/repo/x", worktreePath: "/wt/z" })
  })

  it("includes branch/vendor/title only when given (resolving paths)", async () => {
    const client = new FakeClient({ "worktree.adopt": () => ({ task: taskFixture() }) })
    await invokeVerb(
      "adopt",
      ["--repo", "rel-repo", "--worktree", "rel-wt", "--branch", "b1", "--vendor", "codex", "--title", "Adopted"],
      { client, runtime: stubRuntime() },
    )
    expect(client.requests[0].payload).toEqual({
      repo: `${process.cwd()}/rel-repo`,
      worktreePath: `${process.cwd()}/rel-wt`,
      branch: "b1",
      vendor: "codex",
      title: "Adopted",
    })
  })
})

// ── deliverPrompt: the delivery decision tree ────────────────────────────────

describe("deliverPrompt", () => {
  function fakeOps(overrides: Partial<PromptDeliveryOps> = {}) {
    const ensured: EnsureSessionOpts[] = []
    const pasted: Array<{ pane: string; text: string }> = []
    const waited: Array<{ session: string; fresh: boolean }> = []
    const ops: PromptDeliveryOps = {
      sessionExists: async () => false,
      ensureSession: async (opts) => {
        ensured.push(opts)
        return true
      },
      waitForEnginePane: async (session, fresh) => {
        waited.push({ session, fresh })
        return { pane: "%9", ready: true }
      },
      pasteAndSubmit: async (pane, text) => {
        pasted.push({ pane, text })
      },
      resolveRepoInit: async () => ({}),
      engineCommand: () => ["claude", "--continue"],
      ...overrides,
    }
    return { ops, ensured, pasted, waited }
  }

  const target: PromptTarget = { id: "t1", worktreePath: "/wt/t1", vendor: "claude", repo: "/repo/x" }

  it("reuses a live session: no rebuild, non-fresh wait, started:false", async () => {
    const { ops, ensured, pasted, waited } = fakeOps({ sessionExists: async () => true })
    const result = await deliverPrompt(new FakeClient(), target, "hello", ops)
    expect(ensured).toEqual([])
    expect(waited).toEqual([{ session: tmuxSessionName("t1"), fresh: false }])
    expect(pasted).toEqual([{ pane: "%9", text: "hello" }])
    expect(result).toEqual({ session: tmuxSessionName("t1"), pane: "%9", started: false, engineReady: true })
  })

  it("builds a fresh session with the engine command in the worktree, then waits fresh", async () => {
    const { ops, ensured, waited } = fakeOps()
    const result = await deliverPrompt(new FakeClient(), target, "hello", ops)
    expect(ensured).toHaveLength(1)
    expect(ensured[0]).toMatchObject({
      name: tmuxSessionName("t1"),
      cwd: "/wt/t1",
      command: ["claude", "--continue"],
      taskId: "t1",
      vendor: "claude",
      repo: "/repo/x",
    })
    expect(waited).toEqual([{ session: tmuxSessionName("t1"), fresh: true }])
    expect(result.started).toBe(true)
  })

  it("delivers the EXPLICIT prompt, not the repo's first prompt (init script still runs)", async () => {
    // CLAUDE.md contract: `kobe api … --prompt` runs the init script but
    // delivers the explicit prompt INSTEAD of the repo's init-prompt — a
    // fresh session must never get both pastes.
    const { ops, ensured, pasted } = fakeOps({
      resolveRepoInit: async () => ({ initScript: "./setup.sh", initPrompt: "REPO FIRST PROMPT" }),
    })
    await deliverPrompt(new FakeClient(), target, "explicit prompt", ops)
    expect(ensured[0].initScript).toBe("./setup.sh")
    expect(ensured[0].initPrompt).toBeUndefined()
    expect(pasted).toEqual([{ pane: "%9", text: "explicit prompt" }])
  })

  it("materializes a missing worktree via task.ensureWorktree first", async () => {
    const client = new FakeClient({ "task.ensureWorktree": () => ({ worktreePath: "/wt/made" }) })
    const { ops, ensured } = fakeOps()
    await deliverPrompt(client, { ...target, worktreePath: "" }, "hello", ops)
    expect(client.requests).toEqual([{ name: "task.ensureWorktree", payload: { taskId: "t1" } }])
    expect(ensured[0].cwd).toBe("/wt/made")
  })

  it("fails NO_WORKTREE when even ensureWorktree yields nothing", async () => {
    const client = new FakeClient({ "task.ensureWorktree": () => ({ worktreePath: "" }) })
    const { ops } = fakeOps()
    await expectApiError(
      () => deliverPrompt(client, { ...target, worktreePath: "" }, "hello", ops),
      "NO_WORKTREE",
      "task t1 has no worktree",
    )
  })

  it("fails SESSION_FAILED when the tmux session can't be built", async () => {
    const { ops } = fakeOps({ ensureSession: async () => false })
    await expectApiError(() => deliverPrompt(new FakeClient(), target, "hello", ops), "SESSION_FAILED")
  })

  it("fails NO_ENGINE_PANE when no engine pane ever appears", async () => {
    const { ops } = fakeOps({ waitForEnginePane: async () => ({ pane: "", ready: false }) })
    await expectApiError(() => deliverPrompt(new FakeClient(), target, "hello", ops), "NO_ENGINE_PANE")
  })

  it("still delivers best-effort when readiness never confirms (engineReady:false)", async () => {
    const { ops, pasted } = fakeOps({ waitForEnginePane: async () => ({ pane: "%9", ready: false }) })
    const result = await deliverPrompt(new FakeClient(), target, "hello", ops)
    expect(result.engineReady).toBe(false)
    expect(pasted).toHaveLength(1)
  })
})
