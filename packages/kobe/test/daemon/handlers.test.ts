import { EngineEventLog } from "@sma1lboy/kobe-daemon/daemon/engine-events-log"
import { PromptBroker } from "@sma1lboy/kobe-daemon/daemon/prompt-broker"
import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import {
  type DaemonHandlerContext,
  createDaemonHandlerRegistry,
  dispatchDaemonRequest,
} from "@sma1lboy/kobe-daemon/daemon/server"
import { describe, expect, it } from "vitest"
import type { Task } from "../../src/types/task.ts"
import { fakeCtx } from "./handler-test-context.ts"

/**
 * RPC dispatch seam tests (registry in `kobe-daemon/src/daemon/handlers.ts`).
 *
 * WHY these matter: the daemon's dispatch used to be a ~275-line switch in
 * `server.ts` with ZERO direct tests — the only proof the RPC surface worked
 * was the end-to-end socket suite. The registry makes the seam testable
 * WITHOUT a socket: dispatch through a fake context and assert the payload. These tests pin the
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
      "task.land",
      "task.pin",
      "task.move",
      "task.status",
      "task.report",
      "task.reorder",
      "task.ensureMain",
      "task.openDir",
      "project.forget",
      "task.ensureWorktree",
      "task.setActive",
      "issue.list",
      "issue.mutate",
      "worktree.discoverAdoptable",
      "worktree.adopt",
      "worktree.reconcile",
      "worktree.archiveRemoved",
      "worktree.list",
      "worktree.remove",
      "engine.reportEvent",
      "engine.beginSession",
      "engine.pinSession",
      "attention.dismiss",
      "attention.read",
      "automation.list",
      "automation.create",
      "automation.update",
      "automation.delete",
      "automation.runs",
      "automation.runNow",
      "workitem.list",
      "workitem.start",
      "session.deliver",
      "task.recentEvents",
      "ui.reportEvent",
      "ui.prompt",
      "ui.promptReply",
      "tab.open",
      "notice.send",
      "note.file",
    ]
    const registry = createDaemonHandlerRegistry()
    for (const name of rpcNames) expect(registry.get(name), name).toBeDefined()
    expect(registry.has("subscribe")).toBe(false)
    expect(registry.size).toBe(rpcNames.length)
  })

  describe("ui.reportEvent", () => {
    it("feeds valid UI kinds to the plugin sink and rejects unknown kinds", async () => {
      const { ctx } = fakeCtx({ getTask: () => TASK })
      const seen: unknown[] = []
      ;(ctx as { plugins?: unknown }).plugins = {
        handleEngineReport: () => {},
        handleUiReport: (r: unknown) => seen.push(r),
      }
      await dispatch("ui.reportEvent", { kind: "file.opened", taskId: "t1", detail: { path: "/x.mp4" } }, ctx)
      expect(seen).toEqual([{ kind: "file.opened", taskId: "t1", detail: { path: "/x.mp4" } }])
      await expect(dispatch("ui.reportEvent", { kind: "task.created" }, ctx)).rejects.toThrow(/unknown ui event/)
    })
  })

  describe("ui.prompt / ui.promptReply", () => {
    it("publishes the request and resolves with the reply (first answer wins)", async () => {
      const { ctx, rec } = fakeCtx({ getTask: () => TASK })
      ;(ctx as { prompts?: PromptBroker }).prompts = new PromptBroker()
      const pending = dispatch("ui.prompt", { title: "URL?", placeholder: "https://…" }, ctx)
      const published = rec.published.find((p) => p.channel === "ui.prompt")
      expect(published?.payload).toMatchObject({ title: "URL?", placeholder: "https://…" })
      const promptId = (published?.payload as { promptId: string }).promptId
      const ok = await dispatch("ui.promptReply", { promptId, value: "https://kobe.dev" }, ctx)
      expect(ok).toEqual({ ok: true })
      expect(await pending).toEqual({ value: "https://kobe.dev" })
      // A second reply to the same prompt is dropped.
      expect(await dispatch("ui.promptReply", { promptId, value: "late" }, ctx)).toEqual({ ok: false })
    })

    it("a value-less reply cancels, and unknown ids settle nothing", async () => {
      const { ctx, rec } = fakeCtx({ getTask: () => TASK })
      ;(ctx as { prompts?: PromptBroker }).prompts = new PromptBroker()
      const pending = dispatch("ui.prompt", { title: "name?" }, ctx)
      const promptId = (rec.published.find((p) => p.channel === "ui.prompt")?.payload as { promptId: string }).promptId
      expect(await dispatch("ui.promptReply", { promptId: "nope", value: "x" }, ctx)).toEqual({ ok: false })
      await dispatch("ui.promptReply", { promptId }, ctx)
      expect(await pending).toEqual({ cancelled: true, reason: "cancelled" })
    })
  })

  // Lifecycle-buffer cases moved to handlers-runtime.test.ts (file-size cap).
  describe("tab.open", () => {
    it("publishes a tab.open event for a known task", async () => {
      const { ctx, rec } = fakeCtx({ getTask: (id: string) => (id === "t1" ? TASK : undefined) })
      const before = Date.now()
      const result = await dispatch("tab.open", { taskId: "t1", argv: ["sh", "-lc", "true"], title: "demo" }, ctx)
      expect(result).toEqual({ ok: true })
      const event = rec.published[0] as { channel: string; payload: Record<string, unknown> }
      expect(event.channel).toBe("tab.open")
      expect(event.payload).toMatchObject({ taskId: "t1", argv: ["sh", "-lc", "true"], title: "demo" })
      expect(event.payload.at as number).toBeGreaterThanOrEqual(before)
    })

    it("rejects an unknown task and a malformed argv", async () => {
      const { ctx } = fakeCtx({ getTask: () => undefined })
      await expect(dispatch("tab.open", { taskId: "nope", argv: ["x"], title: "t" }, ctx)).rejects.toThrow(
        /task not found/,
      )
      const { ctx: ctx2 } = fakeCtx({ getTask: () => TASK })
      await expect(dispatch("tab.open", { taskId: "t1", argv: [], title: "t" }, ctx2)).rejects.toThrow(/argv/)
    })
  })

  describe("notice.send", () => {
    it("publishes a notice.event with a stamped `at` and the default kind", async () => {
      const { ctx, rec } = fakeCtx()
      const before = Date.now()
      const result = await dispatch("notice.send", { title: "build done" }, ctx)
      expect(result).toEqual({ ok: true })
      expect(rec.published).toHaveLength(1)
      const event = rec.published[0] as { channel: string; payload: Record<string, unknown> }
      expect(event.channel).toBe("notice.event")
      expect(event.payload.title).toBe("build done")
      expect(event.payload.kind).toBe("done")
      expect(event.payload.taskId).toBeUndefined()
      expect(typeof event.payload.at).toBe("number")
      expect(event.payload.at as number).toBeGreaterThanOrEqual(before)
    })

    it("carries kind/taskId/source through when valid", async () => {
      const { ctx, rec } = fakeCtx({ getTask: (id: string) => (id === "t1" ? TASK : undefined) })
      await dispatch(
        "notice.send",
        { title: "needs a decision", kind: "needs_input", taskId: "t1", source: "api" },
        ctx,
      )
      const payload = (rec.published[0] as { payload: Record<string, unknown> }).payload
      expect(payload.kind).toBe("needs_input")
      expect(payload.taskId).toBe("t1")
      expect(payload.source).toBe("api")
    })

    it("accepts an arbitrary agent-invented kind verbatim", async () => {
      const { ctx, rec } = fakeCtx()
      await dispatch("notice.send", { title: "review round 2 posted", kind: "review-ready" }, ctx)
      const payload = (rec.published[0] as { payload: Record<string, unknown> }).payload
      expect(payload.kind).toBe("review-ready")
    })

    it("rejects an empty kind and an unknown task", async () => {
      const { ctx, rec } = fakeCtx({ getTask: () => undefined })
      await expect(dispatch("notice.send", { title: "x", kind: "  " }, ctx)).rejects.toThrow(
        "kind must be a non-empty string",
      )
      await expect(dispatch("notice.send", { title: "x", taskId: "nope" }, ctx)).rejects.toThrow("task not found: nope")
      expect(rec.published).toHaveLength(0)
    })
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

    it("task.delete durably prepares, clears activity, and enqueues background cleanup", async () => {
      const prepared: unknown[] = []
      const { ctx, rec } = fakeCtx({
        prepareTaskDeletion: async (id: string, opts: unknown) => {
          prepared.push([id, opts])
          return true
        },
      })
      await expect(dispatch("task.delete", { taskId: "t1", force: true }, ctx)).resolves.toEqual({})
      expect(prepared).toEqual([["t1", { force: true }]])
      expect(rec.cleared).toEqual(["t1"])
      expect(rec.inboxTaskDeleted).toEqual(["t1"])
      expect(rec.deletions).toEqual(["t1"])
    })

    it("task.delete refuses a dirty worktree before any destructive step", async () => {
      // The dirty-worktree preflight lives in prepareTaskDeletion; when it
      // throws, the handler must abort BEFORE the destructive tail: no
      // activity clear, no Inbox cascade, and — critically — no background
      // deletion enqueued (the deletion runner is the only place session/PTY
      // teardown happens, so no enqueue == no teardown).
      const { ctx, rec } = fakeCtx({
        prepareTaskDeletion: async () => {
          throw new Error("refused: DIRTY_WORKTREE")
        },
      })
      await expect(dispatch("task.delete", { taskId: "t1" }, ctx)).rejects.toThrow("DIRTY_WORKTREE")
      expect(rec.cleared).toEqual([])
      expect(rec.inboxTaskDeleted).toEqual([])
      expect(rec.deletions).toEqual([])
    })

    it("task.delete does not enqueue an unknown task", async () => {
      const { ctx, rec } = fakeCtx({ prepareTaskDeletion: async () => false })
      await expect(dispatch("task.delete", { taskId: "missing" }, ctx)).resolves.toEqual({})
      expect(rec.deletions).toEqual([])
      expect(rec.inboxTaskDeleted).toEqual(["missing"])
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

  // Runtime-oriented cases moved to handlers-runtime.test.ts (file-size cap).
})
