import type { DaemonActivityRegistry } from "@sma1lboy/kobe-daemon/daemon/activity-registry"
import type { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import type { IssuesStore } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import {
  type DaemonHandlerContext,
  createDaemonHandlerRegistry,
  dispatchDaemonRequest,
  shapeDaemonError,
} from "@sma1lboy/kobe-daemon/daemon/server"
import { describe, expect, it } from "vitest"
import type { Orchestrator } from "../../src/orchestrator/core.ts"
import type { Task } from "../../src/types/task.ts"

/**
 * RPC dispatch seam tests (registry in `kobe-daemon/src/daemon/handlers.ts`).
 *
 * WHY these matter: the daemon's dispatch used to be a ~275-line switch in
 * `server.ts` with ZERO direct tests — the only proof the RPC surface worked
 * was the end-to-end socket suite. The registry makes the seam testable
 * WITHOUT a socket: build the registry, hand it a fake Orchestrator through
 * the context, dispatch a request, assert the payload. These tests pin the
 * WIRE CONTRACT — success payload shapes (including which calls return `{}`
 * vs an object), validation-error wording (`"repo is required"`), and the
 * unknown-request error — so a future handler edit that drifts the on-wire
 * shape fails here first, not in a client.
 *
 * `subscribe` is deliberately absent from the registry (connection
 * lifecycle — per-socket state + the gui-refcount idle timer + direct
 * channel-replay writes); its behavior is covered end-to-end by
 * `lazy-shutdown.test.ts` over a real socket.
 */

const TASK: Task = {
  id: "t1",
  title: "demo task",
  repo: "/repo",
  branch: "kobe/demo",
  worktreePath: "/repo/.kobe/worktrees/demo",
  kind: "task",
  status: "in_progress",
  archived: false,
  pinned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
} as Task

/** What `serializeTask(TASK)` puts on the wire (pinned literally on purpose). */
const SERIALIZED_TASK = {
  id: "t1",
  title: "demo task",
  repo: "/repo",
  branch: "kobe/demo",
  worktreePath: "/repo/.kobe/worktrees/demo",
  kind: "task",
  status: "in_progress",
  archived: false,
  pinned: false,
  vendor: undefined,
  prStatus: undefined,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
}

interface Recorded {
  readonly published: Array<{ channel: string; payload: unknown }>
  readonly reported: Array<{ taskId: string; kind: string; detail?: unknown }>
  readonly issueCalls: Array<{ method: string; repo: unknown; op?: unknown }>
  readonly cleared: string[]
  stopped: number
}

/** Build a handler context around a partial fake Orchestrator — no socket. */
function fakeCtx(orch: Record<string, unknown> = {}): { ctx: DaemonHandlerContext; rec: Recorded } {
  const rec: Recorded = { published: [], reported: [], issueCalls: [], cleared: [], stopped: 0 }
  const ctx: DaemonHandlerContext = {
    orch: { listTasks: () => [], ...orch } as unknown as Orchestrator,
    bus: {
      publish: (channel: string, payload: unknown) => rec.published.push({ channel, payload }),
    } as unknown as DaemonEventBus,
    activity: {
      report: (taskId: string, kind: string, detail?: unknown) => rec.reported.push({ taskId, kind, detail }),
      clearTask: (taskId: string) => rec.cleared.push(taskId),
    } as unknown as DaemonActivityRegistry,
    issues: {
      list: async (repo: unknown) => {
        rec.issueCalls.push({ method: "list", repo })
        return { repoRoot: String(repo), exists: false, nextId: 1, issues: [] }
      },
      mutate: async (repo: unknown, op: unknown) => {
        rec.issueCalls.push({ method: "mutate", repo, op })
        return { repoRoot: String(repo), exists: true, nextId: 2, issues: [] }
      },
    } as unknown as IssuesStore,
    daemon: {
      startedAt: new Date("2026-06-01T00:00:00.000Z"),
      socketPath: "/tmp/fake/daemon.sock",
      pid: 4242,
      guiCount: () => 1,
      stopSoon: async () => {
        rec.stopped++
      },
    },
    clientId: 7,
  }
  return { ctx, rec }
}

function dispatch(name: string, payload: unknown, ctx: DaemonHandlerContext): Promise<unknown> {
  return dispatchDaemonRequest(createDaemonHandlerRegistry(), name, payload, ctx)
}

describe("daemon handler registry", () => {
  it("covers every RPC name except subscribe (connection lifecycle stays in server.ts)", () => {
    // Compile-time: this array must be DaemonRequestNames; runtime: each has
    // an entry. `subscribe` is the documented special case.
    const rpcNames: DaemonRequestName[] = [
      "hello",
      "daemon.status",
      "daemon.stop",
      "task.list",
      "task.get",
      "task.create",
      "task.archive",
      "task.rename",
      "task.setBranch",
      "task.setVendor",
      "task.delete",
      "task.pin",
      "task.move",
      "task.status",
      "task.reorder",
      "task.ensureMain",
      "project.forget",
      "task.ensureWorktree",
      "task.setActive",
      "issue.list",
      "issue.mutate",
      "worktree.discoverAdoptable",
      "worktree.adopt",
      "worktree.reconcile",
      "worktree.archiveRemoved",
      "engine.reportEvent",
      "session.deliver",
      "note.file",
    ]
    const registry = createDaemonHandlerRegistry()
    for (const name of rpcNames) expect(registry.get(name), name).toBeDefined()
    expect(registry.has("subscribe")).toBe(false)
    expect(registry.size).toBe(rpcNames.length)
  })

  describe("task CRUD", () => {
    it("task.create returns { taskId, task } and forwards normalized options", async () => {
      const calls: unknown[] = []
      const { ctx } = fakeCtx({
        createTask: async (opts: unknown) => {
          calls.push(opts)
          return TASK
        },
      })
      const result = await dispatch("task.create", { repo: "/repo", title: "demo task" }, ctx)
      expect(result).toEqual({ taskId: "t1", task: SERIALIZED_TASK })
      // Absent optionals must arrive as undefined (NOT empty strings) — the
      // orchestrator treats them as "use default".
      expect(calls).toEqual([
        { repo: "/repo", title: "demo task", branch: undefined, baseRef: undefined, vendor: undefined },
      ])
    })

    it("task.create without repo fails with the exact legacy wording", async () => {
      const { ctx } = fakeCtx({
        createTask: async () => {
          throw new Error("must not be called")
        },
      })
      await expect(dispatch("task.create", {}, ctx)).rejects.toThrow("repo is required")
    })

    it("task.get returns the serialized task, and the not-found error keeps its wording", async () => {
      const { ctx } = fakeCtx({ getTask: (id: string) => (id === "t1" ? TASK : undefined) })
      await expect(dispatch("task.get", { taskId: "t1" }, ctx)).resolves.toEqual({ task: SERIALIZED_TASK })
      await expect(dispatch("task.get", { taskId: "nope" }, ctx)).rejects.toThrow("task not found: nope")
      await expect(dispatch("task.get", {}, ctx)).rejects.toThrow("taskId is required")
    })

    it("task.rename returns the empty object and validates both fields", async () => {
      const renames: Array<[string, string]> = []
      const { ctx } = fakeCtx({
        setTitle: async (id: string, title: string) => {
          renames.push([id, title])
        },
      })
      await expect(dispatch("task.rename", { taskId: "t1", title: "new" }, ctx)).resolves.toEqual({})
      expect(renames).toEqual([["t1", "new"]])
      await expect(dispatch("task.rename", { taskId: "t1" }, ctx)).rejects.toThrow("title is required")
    })

    it("task.reorder forwards a validated batch and returns the empty object", async () => {
      const batches: unknown[] = []
      const { ctx } = fakeCtx({
        reorderTasks: async (moves: unknown) => {
          batches.push(moves)
        },
      })
      await expect(dispatch("task.reorder", { moves: [{ taskId: "t1", position: 1.5 }] }, ctx)).resolves.toEqual({})
      expect(batches).toEqual([[{ taskId: "t1", position: 1.5 }]])
    })

    it("task.reorder rejects an empty batch and non-finite positions", async () => {
      const { ctx } = fakeCtx({
        reorderTasks: async () => {
          throw new Error("must not be called")
        },
      })
      await expect(dispatch("task.reorder", { moves: [] }, ctx)).rejects.toThrow("moves must be a non-empty array")
      await expect(dispatch("task.reorder", {}, ctx)).rejects.toThrow("moves must be a non-empty array")
      await expect(dispatch("task.reorder", { moves: [{ taskId: "t1", position: Number.NaN }] }, ctx)).rejects.toThrow(
        "position must be a finite number",
      )
      await expect(dispatch("task.reorder", { moves: [{ position: 1 }] }, ctx)).rejects.toThrow("taskId is required")
    })

    it("task.delete clears the task's transient activity after the orchestrator delete", async () => {
      const deleted: unknown[] = []
      const { ctx, rec } = fakeCtx({
        deleteTask: async (id: string, opts: unknown) => {
          deleted.push([id, opts])
        },
      })
      await expect(dispatch("task.delete", { taskId: "t1", force: true }, ctx)).resolves.toEqual({})
      expect(deleted).toEqual([["t1", { force: true }]])
      expect(rec.cleared).toEqual(["t1"])
    })

    it("task.move rejects a bogus direction with the legacy wording", async () => {
      const { ctx } = fakeCtx()
      await expect(dispatch("task.move", { taskId: "t1", direction: "sideways" }, ctx)).rejects.toThrow(
        "direction must be up or down",
      )
    })
  })

  describe("issues", () => {
    it("issue.list and issue.mutate delegate to the daemon-owned issue store", async () => {
      const { ctx, rec } = fakeCtx()
      await expect(dispatch("issue.list", { repoRoot: "/repo" }, ctx)).resolves.toEqual({
        repoRoot: "/repo",
        exists: false,
        nextId: 1,
        issues: [],
      })
      await expect(
        dispatch("issue.mutate", { repoRoot: "/repo", op: { type: "setStatus", id: 8, status: "done" } }, ctx),
      ).resolves.toEqual({ repoRoot: "/repo", exists: true, nextId: 2, issues: [] })
      expect(rec.issueCalls).toEqual([
        { method: "list", repo: "/repo" },
        { method: "mutate", repo: "/repo", op: { type: "setStatus", id: 8, status: "done" } },
      ])
      expect(rec.published).toEqual([
        {
          channel: "issue.snapshot",
          payload: { repoRoot: "/repo", exists: true, nextId: 2, issues: [] },
        },
      ])
    })
  })

  describe("worktree.archiveRemoved", () => {
    const TASKS = [
      { id: "main", repo: "/repo", worktreePath: "/repo" },
      { id: "sub", repo: "/repo", worktreePath: "/repo/.kobe/worktrees/demo" },
    ]

    it("archives the task whose worktree was removed", async () => {
      const archived: Array<[string, boolean | undefined]> = []
      const { ctx } = fakeCtx({
        listTasks: () => TASKS,
        setArchived: async (id: string, value?: boolean) => {
          archived.push([id, value])
        },
      })
      await expect(
        dispatch("worktree.archiveRemoved", { worktreePath: "/repo/.kobe/worktrees/demo" }, ctx),
      ).resolves.toEqual({ archived: true, taskId: "sub" })
      expect(archived).toEqual([["sub", true]])
    })

    it("is a no-op when no task matches the removed worktree exactly", async () => {
      const archived: unknown[] = []
      const { ctx } = fakeCtx({
        listTasks: () => TASKS,
        setArchived: async (id: string) => {
          archived.push(id)
        },
      })
      // An untracked worktree under /repo must NOT archive the main task.
      await expect(
        dispatch("worktree.archiveRemoved", { worktreePath: "/repo/.kobe/worktrees/unknown" }, ctx),
      ).resolves.toEqual({ archived: false })
      expect(archived).toEqual([])
    })
  })

  describe("task.ensureWorktree", () => {
    it("returns { worktreePath } from the orchestrator", async () => {
      const { ctx } = fakeCtx({ ensureWorktree: async (id: string) => `/worktrees/${id}` })
      await expect(dispatch("task.ensureWorktree", { taskId: "t1" }, ctx)).resolves.toEqual({
        worktreePath: "/worktrees/t1",
      })
    })

    it("rejects a missing taskId", async () => {
      const { ctx } = fakeCtx()
      await expect(dispatch("task.ensureWorktree", {}, ctx)).rejects.toThrow("taskId is required")
    })

    // Long-operation feedback (issue #5): `git worktree add` is minute-class
    // on a huge repo and the RPC stays blocking, so the handler must publish
    // lifecycle progress on `task.jobs` around the call — running before,
    // and ALWAYS a terminal phase after (done on success, error on throw).
    // Without the guaranteed terminal publish, the bus's last-value replay
    // would show late subscribers a stuck "running" forever.
    it("publishes task.jobs running → done around a successful materialisation", async () => {
      let publishedWhenWorkStarted = -1
      const { ctx, rec } = fakeCtx({
        ensureWorktree: async (id: string) => {
          publishedWhenWorkStarted = rec.published.length
          return `/worktrees/${id}`
        },
      })
      await dispatch("task.ensureWorktree", { taskId: "t1" }, ctx)
      // `running` was already on the bus when the orchestrator call started.
      expect(publishedWhenWorkStarted).toBe(1)
      expect(rec.published).toEqual([
        { channel: "task.jobs", payload: { taskId: "t1", kind: "ensureWorktree", phase: "running" } },
        { channel: "task.jobs", payload: { taskId: "t1", kind: "ensureWorktree", phase: "done" } },
      ])
    })

    it("publishes task.jobs running → error (with the message) when the orchestrator throws, and rethrows", async () => {
      const { ctx, rec } = fakeCtx({
        ensureWorktree: async () => {
          throw new Error("git worktree add failed")
        },
      })
      await expect(dispatch("task.ensureWorktree", { taskId: "t1" }, ctx)).rejects.toThrow("git worktree add failed")
      expect(rec.published).toEqual([
        { channel: "task.jobs", payload: { taskId: "t1", kind: "ensureWorktree", phase: "running" } },
        {
          channel: "task.jobs",
          payload: { taskId: "t1", kind: "ensureWorktree", phase: "error", error: "git worktree add failed" },
        },
      ])
    })

    it("coerces a non-Error throw into the error string on the terminal publish", async () => {
      const { ctx, rec } = fakeCtx({
        ensureWorktree: async () => {
          throw "plain failure"
        },
      })
      await expect(dispatch("task.ensureWorktree", { taskId: "t1" }, ctx)).rejects.toBe("plain failure")
      expect(rec.published[1]).toEqual({
        channel: "task.jobs",
        payload: { taskId: "t1", kind: "ensureWorktree", phase: "error", error: "plain failure" },
      })
    })
  })

  describe("engine.reportEvent (payload contract pinned — the activity hooks depend on it)", () => {
    it("maps cwd → task and folds the coerced detail into the activity registry", async () => {
      const { ctx, rec } = fakeCtx({ listTasks: () => [TASK] })
      const result = await dispatch(
        "engine.reportEvent",
        {
          kind: "awaiting-input",
          cwd: `${TASK.worktreePath}/src/deep`,
          // `junk` must be dropped; the normalized keys survive.
          detail: { waiting: "permission", junk: 1 },
        },
        ctx,
      )
      expect(result).toEqual({})
      expect(rec.reported).toEqual([{ taskId: "t1", kind: "awaiting-input", detail: { waiting: "permission" } }])
    })

    it("an explicit taskId wins over cwd resolution", async () => {
      const { ctx, rec } = fakeCtx({ listTasks: () => [TASK] })
      await dispatch("engine.reportEvent", { kind: "turn-complete", taskId: "direct", cwd: TASK.worktreePath }, ctx)
      expect(rec.reported).toEqual([{ taskId: "direct", kind: "turn-complete", detail: undefined }])
    })

    it("an unmatched cwd is silently dropped (returns {} with no report)", async () => {
      const { ctx, rec } = fakeCtx({ listTasks: () => [TASK] })
      await expect(
        dispatch("engine.reportEvent", { kind: "turn-start", cwd: "/somewhere/else" }, ctx),
      ).resolves.toEqual({})
      expect(rec.reported).toEqual([])
    })

    it("rejects an unknown kind and a missing kind with the exact wording", async () => {
      const { ctx } = fakeCtx()
      await expect(dispatch("engine.reportEvent", { kind: "explode" }, ctx)).rejects.toThrow(
        "unknown engine event kind: explode",
      )
      await expect(dispatch("engine.reportEvent", { cwd: "/x" }, ctx)).rejects.toThrow("kind is required")
    })
  })

  describe("daemon surface", () => {
    it("daemon.status reports the ctx-provided facts in the wire shape", async () => {
      const { ctx } = fakeCtx({ listTasks: () => [TASK] })
      const status = (await dispatch("daemon.status", {}, ctx)) as Record<string, unknown>
      expect(status.daemonPid).toBe(4242)
      expect(status.attachedClients).toBe(1)
      expect(status.taskCount).toBe(1)
      expect(status.socketPath).toBe("/tmp/fake/daemon.sock")
      expect(status.startedAt).toBe("2026-06-01T00:00:00.000Z")
      expect(typeof status.uptimeMs).toBe("number")
      expect(typeof status.kobeVersion).toBe("string")
    })

    it("daemon.stop drives stopSoon and returns the empty object", async () => {
      const { ctx, rec } = fakeCtx()
      await expect(dispatch("daemon.stop", {}, ctx)).resolves.toEqual({})
      expect(rec.stopped).toBe(1)
    })

    it("task.setActive publishes the active-task channel after the orchestrator call", async () => {
      const active: Array<string | null> = []
      const { ctx, rec } = fakeCtx({
        setActiveTask: async (id: string | null) => {
          active.push(id)
        },
      })
      await expect(dispatch("task.setActive", { taskId: "t1" }, ctx)).resolves.toEqual({})
      // Omitted taskId means "clear focus" — null, not an error.
      await expect(dispatch("task.setActive", {}, ctx)).resolves.toEqual({})
      expect(active).toEqual(["t1", null])
      expect(rec.published).toEqual([
        { channel: "active-task", payload: { taskId: "t1" } },
        { channel: "active-task", payload: { taskId: null } },
      ])
    })
  })

  describe("error shaping (one place decides the wire error)", () => {
    it("an unknown request keeps the legacy message", async () => {
      const { ctx } = fakeCtx()
      // e.g. a v2 client's removed `daemon.web.start` must still get this.
      await expect(dispatch("daemon.web.start", {}, ctx)).rejects.toThrow("unknown daemon request: daemon.web.start")
    })

    it("shapeDaemonError matches the historical on-the-wire shape exactly", () => {
      // Error instance → message + name ("Error" serializes onto the wire).
      expect(shapeDaemonError(new Error("boom"))).toEqual({ message: "boom", name: "Error" })
      const typed = new TypeError("bad type")
      expect(shapeDaemonError(typed)).toEqual({ message: "bad type", name: "TypeError" })
      // Non-Error throw → String() coercion, name undefined (dropped by
      // JSON.stringify, so the key never appears on the wire — pinned here).
      const shaped = shapeDaemonError("plain string")
      expect(shaped).toEqual({ message: "plain string", name: undefined })
      expect(JSON.stringify(shaped)).toBe('{"message":"plain string"}')
    })
  })
})
