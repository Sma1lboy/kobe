/**
 * Registry tests for the task-lifecycle half of the RPC surface: task CRUD,
 * the issue store delegation, and the two worktree verbs. Split out of
 * `handlers.test.ts` when that file crossed the 500-line cap; same contract,
 * same fakes — see that file's header for WHY these dispatch-seam tests
 * exist at all. Shared fixtures (`TASK`, `SERIALIZED_TASK`, `dispatch`) live
 * in `handler-test-context.ts` so neither suite imports the other.
 */

import { describe, expect, it } from "vitest"
import { SERIALIZED_TASK, TASK, dispatch, fakeCtx } from "./handler-test-context.ts"

describe("daemon handler registry — tasks, issues, worktrees", () => {
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
})
