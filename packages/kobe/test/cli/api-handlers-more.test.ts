/**
 * `kobe api` verb handlers not covered by api-handlers.test.ts: the leveled
 * schema drill-ins (--verb / --group), the simple-RPC edit verbs (rename /
 * set-branch / set-vendor / set-status / pin), the issue verbs, and the
 * dispatch / note delivery verbs — plus the VerbArgs coercion errors that
 * only a handler (not spec validation) can raise. Same technique as the
 * sibling file: `invokeVerb` against a fake daemon client that records
 * request traffic; these pin RPC names + payloads scripts depend on.
 */

import { describe, expect, it } from "vitest"
import {
  API_SCHEMA_VERSION,
  ApiError,
  type ApiRuntime,
  VerbArgs,
  findVerb,
  invokeVerb,
  verbSchema,
} from "../../src/cli/api-cmd.ts"
import type { DaemonRpc } from "../../src/cli/daemon-session.ts"

/** Records every request; answers from a per-RPC responder table. */
class FakeClient implements DaemonRpc {
  readonly requests: Array<{ name: string; payload: unknown }> = []
  constructor(private readonly responders: Record<string, (payload: unknown) => unknown> = {}) {}

  async request<T = unknown>(name: string, payload?: unknown): Promise<T> {
    this.requests.push({ name, payload })
    const respond = this.responders[name]
    if (!respond) throw new Error(`fake daemon has no responder for "${name}"`)
    return respond(payload) as T
  }

  async subscribe(): Promise<unknown> {
    return {}
  }

  onChannel(): () => void {
    return () => {}
  }
}

function stubRuntime(): ApiRuntime {
  return {
    isTaskRunning: async () => false,
    deliverPrompt: async () => {
      throw new Error("deliverPrompt should not run in this test")
    },
    resolveRepoRoot: async (p) => p,
    defaultVendor: async () => undefined,
    readWorktreeChanges: async () => ({ added: 0, deleted: 0 }),
    tearDownSession: async () => {},
  }
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

const offline = { client: null, runtime: stubRuntime() }

describe("schema drill-ins", () => {
  it("--verb returns ONE verb's full flag detail with its group", async () => {
    const result = (await invokeVerb("schema", ["--verb", "list"], offline)) as {
      name: string
      group: string
      flags: unknown[]
    }
    expect(result.name).toBe("list")
    expect(result.group).toBe("read")
    expect(Array.isArray(result.flags)).toBe(true)
  })

  it("--verb resolves an alias to its canonical verb", async () => {
    const result = (await invokeVerb("schema", ["--verb", "spawn-task"], offline)) as { name: string }
    expect(result.name).toBe("add")
  })

  it("--verb with an unknown name is BAD_VERB", async () => {
    await expectApiError(() => invokeVerb("schema", ["--verb", "frobnicate"], offline), "BAD_VERB")
  })

  it("--group lists that group's verbs compactly (name + summary only)", async () => {
    const result = (await invokeVerb("schema", ["--group", "read"], offline)) as {
      group: string
      verbs: Array<{ name: string; summary: string }>
    }
    expect(result.group).toBe("read")
    expect(result.verbs.map((v) => v.name)).toEqual(["list", "get-task", "collect", "pty-list"])
    for (const v of result.verbs) expect(v.summary.length).toBeGreaterThan(0)
  })

  it("--group with an unknown group is BAD_FLAG naming the valid groups", async () => {
    await expectApiError(() => invokeVerb("schema", ["--group", "nope"], offline), "BAD_FLAG", /unknown group: nope/)
  })

  it("--all returns the complete spec with the api version", async () => {
    const result = (await invokeVerb("schema", ["--all"], offline)) as { apiVersion: number; verbs: unknown[] }
    expect(result.apiVersion).toBe(API_SCHEMA_VERSION)
    expect(result.verbs.length).toBeGreaterThan(10)
  })

  it("a verb outside every group is reported as group 'other'", async () => {
    const schema = verbSchema({ name: "not-grouped", summary: "s", flags: [], handler: async () => null }) as {
      group: string
    }
    expect(schema.group).toBe("other")
  })
})

describe("edit verbs — RPC name + payload", () => {
  it("rename → task.rename", async () => {
    const client = new FakeClient({ "task.rename": () => ({}) })
    await invokeVerb("rename", ["--task-id", "t1", "--title", "New"], { client, runtime: stubRuntime() })
    expect(client.requests).toEqual([{ name: "task.rename", payload: { taskId: "t1", title: "New" } }])
  })

  it("set-branch → task.setBranch", async () => {
    const client = new FakeClient({ "task.setBranch": () => ({}) })
    await invokeVerb("set-branch", ["--task-id", "t1", "--branch", "feat/x"], { client, runtime: stubRuntime() })
    expect(client.requests).toEqual([{ name: "task.setBranch", payload: { taskId: "t1", branch: "feat/x" } }])
  })

  it("set-vendor → task.setVendor with a validated vendor", async () => {
    const client = new FakeClient({ "task.setVendor": () => ({}) })
    await invokeVerb("set-vendor", ["--task-id", "t1", "--vendor", "codex"], { client, runtime: stubRuntime() })
    expect(client.requests).toEqual([{ name: "task.setVendor", payload: { taskId: "t1", vendor: "codex" } }])
  })

  it("set-status → task.status with a validated status", async () => {
    const client = new FakeClient({ "task.status": () => ({}) })
    await invokeVerb("set-status", ["--task-id", "t1", "--status", "in_review"], { client, runtime: stubRuntime() })
    expect(client.requests).toEqual([{ name: "task.status", payload: { taskId: "t1", status: "in_review" } }])
  })

  it("pin defaults pinned:true; --pinned=false unpins", async () => {
    const client = new FakeClient({ "task.pin": () => ({}) })
    await invokeVerb("pin", ["--task-id", "t1"], { client, runtime: stubRuntime() })
    await invokeVerb("pin", ["--task-id", "t1", "--pinned=false"], { client, runtime: stubRuntime() })
    expect(client.requests.map((r) => r.payload)).toEqual([
      { taskId: "t1", pinned: true },
      { taskId: "t1", pinned: false },
    ])
  })

  it("a non-boolean --pinned value is BAD_FLAG (bool coercion happens in the handler)", async () => {
    const client = new FakeClient({ "task.pin": () => ({}) })
    await expectApiError(
      () => invokeVerb("pin", ["--task-id", "t1", "--pinned=banana"], { client, runtime: stubRuntime() }),
      "BAD_FLAG",
      "--pinned must be a boolean (true/false)",
    )
    expect(client.requests).toEqual([])
  })
})

describe("issue verbs", () => {
  it("issue-create sends a create mutation with the optional body", async () => {
    const client = new FakeClient({ "issue.mutate": () => ({ issues: [] }) })
    await invokeVerb("issue-create", ["--repo", "/repo/x", "--title", "Bug", "--body", "Steps"], {
      client,
      runtime: stubRuntime(),
    })
    expect(client.requests).toEqual([
      {
        name: "issue.mutate",
        payload: { repoRoot: "/repo/x", op: { type: "create", title: "Bug", body: "Steps" } },
      },
    ])
  })

  it("issue-list reads the repo's issues", async () => {
    const client = new FakeClient({ "issue.list": () => ({ issues: [] }) })
    await invokeVerb("issue-list", ["--repo", "/repo/x"], { client, runtime: stubRuntime() })
    expect(client.requests).toEqual([{ name: "issue.list", payload: { repoRoot: "/repo/x" } }])
  })

  it("issue-update with only a title sends an update mutation", async () => {
    const client = new FakeClient({ "issue.mutate": () => ({ issues: [] }) })
    await invokeVerb("issue-update", ["--repo", "/repo/x", "--id", "7", "--title", "Renamed"], {
      client,
      runtime: stubRuntime(),
    })
    expect(client.requests[0].name).toBe("issue.mutate")
    expect(client.requests[0].payload).toMatchObject({
      repoRoot: "/repo/x",
      op: { type: "update", id: 7, title: "Renamed" },
    })
  })

  it("issue-update with only a body works too", async () => {
    const client = new FakeClient({ "issue.mutate": () => ({ issues: [] }) })
    await invokeVerb("issue-update", ["--repo", "/repo/x", "--id", "7", "--body", "More detail"], {
      client,
      runtime: stubRuntime(),
    })
    expect(client.requests[0].payload).toMatchObject({ op: { type: "update", id: 7, body: "More detail" } })
  })

  it("issue-update with neither title nor body is MISSING_FLAG before any RPC", async () => {
    const client = new FakeClient()
    await expectApiError(
      () => invokeVerb("issue-update", ["--repo", "/repo/x", "--id", "7"], { client, runtime: stubRuntime() }),
      "MISSING_FLAG",
      "issue-update requires --title and/or --body",
    )
    expect(client.requests).toEqual([])
  })
})

describe("dispatch / note delivery verbs", () => {
  it("dispatch routes the text through session.deliver tagged as the dispatcher", async () => {
    const client = new FakeClient({ "session.deliver": () => ({}) })
    const result = await invokeVerb("dispatch", ["--task-id", "t1", "--prompt", "focus on the parser"], {
      client,
      runtime: stubRuntime(),
    })
    expect(client.requests).toEqual([
      { name: "session.deliver", payload: { taskId: "t1", text: "focus on the parser", source: "dispatcher" } },
    ])
    expect(result).toEqual({ ok: true, taskId: "t1", routed: "session.deliver" })
  })

  it("note files the field note through note.file and returns the daemon's answer", async () => {
    const client = new FakeClient({ "note.file": () => ({ relayed: 2 }) })
    const result = await invokeVerb("note", ["--task-id", "t1", "--text", "bun install fixes the worktree"], {
      client,
      runtime: stubRuntime(),
    })
    expect(client.requests).toEqual([
      { name: "note.file", payload: { taskId: "t1", text: "bun install fixes the worktree" } },
    ])
    expect(result).toEqual({ relayed: 2 })
  })
})

describe("VerbArgs coercion guards", () => {
  it("enumOf rejects a value outside the spec's declared set", () => {
    const verb = findVerb("set-status")
    expect(verb).toBeDefined()
    const args = new VerbArgs(verb as NonNullable<typeof verb>, new Map([["status", "weird"]]))
    expect(() => args.enumOf("status")).toThrow(ApiError)
    expect(() => args.enumOf("status")).toThrow(/--status must be one of/)
  })

  it("reading an undeclared flag is a loud programming error, not a silent undefined", () => {
    const verb = findVerb("list")
    const args = new VerbArgs(verb as NonNullable<typeof verb>, new Map())
    expect(() => args.str("nope")).toThrow('internal: --nope is not declared on verb "list"')
  })
})
