import { EngineEventLog } from "@sma1lboy/kobe-daemon/daemon/engine-events-log"
import {
  type DaemonHandlerContext,
  createDaemonHandlerRegistry,
  dispatchDaemonRequest,
} from "@sma1lboy/kobe-daemon/daemon/server"
import { describe, expect, it, vi } from "vitest"
import type { Task } from "../../src/types/task.ts"
import { fakeCtx } from "./handler-test-context.ts"

const TASK = {
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

function dispatch(name: string, payload: unknown, ctx: DaemonHandlerContext): Promise<unknown> {
  return dispatchDaemonRequest(createDaemonHandlerRegistry(), name, payload, ctx)
}

describe("daemon runtime handlers", () => {
  describe("engine.reportEvent lifecycle kinds", () => {
    it("buffers every kind, publishes engine.lifecycle for low-frequency ones, and skips the badge", async () => {
      const { ctx, rec } = fakeCtx({ getTask: () => TASK })
      const log = new EngineEventLog()
      const streamed: unknown[] = []
      const unsubscribe = log.subscribe("t1", (event) => streamed.push(event))
      ;(ctx as { engineEvents?: EngineEventLog }).engineEvents = log
      await dispatch("engine.reportEvent", { taskId: "t1", kind: "pre-compact" }, ctx)
      await dispatch(
        "engine.reportEvent",
        {
          taskId: "t1",
          kind: "tool-post",
          engine: "codex",
          sessionId: "session-1",
          detail: {
            turnId: "turn-1",
            tool: {
              name: "exec_command",
              id: "call-1",
              input: "pwd",
              output: "/repo",
              isError: false,
            },
          },
        },
        ctx,
      )
      await dispatch(
        "engine.reportEvent",
        {
          taskId: "t1",
          kind: "subagent-stop",
          engine: "codex",
          sessionId: "session-1",
          detail: {
            turnId: "turn-1",
            subagent: {
              id: "agent-7",
              type: "reviewer",
              transcriptPath: "/tmp/subagent.jsonl",
              result: "Focused tests pass.",
            },
          },
        },
        ctx,
      )
      unsubscribe()
      // Lifecycle-only kinds never touch the activity badge or the inbox.
      expect(rec.reported).toHaveLength(0)
      expect(rec.inboxRecords).toHaveLength(0)
      // Only the low-frequency kind broadcast on engine.lifecycle (no tool spam).
      const lifecycle = rec.published.filter((p) => p.channel === "engine.lifecycle")
      expect(lifecycle).toHaveLength(2)
      expect(lifecycle[0]?.payload).toMatchObject({ taskId: "t1", kind: "pre-compact" })
      // Both kinds landed in the recent-events buffer, readable over RPC.
      const res = (await dispatch("task.recentEvents", { taskId: "t1" }, ctx)) as { events: { kind: string }[] }
      expect(res.events.map((e) => e.kind)).toEqual(["pre-compact", "tool-post", "subagent-stop"])
      expect(streamed[1]).toMatchObject({
        kind: "tool-post",
        vendor: "codex",
        sessionId: "session-1",
        detail: {
          turnId: "turn-1",
          tool: { id: "call-1", output: "/repo", isError: false },
        },
      })
      expect(streamed[2]).toMatchObject({
        kind: "subagent-stop",
        detail: {
          subagent: {
            id: "agent-7",
            transcriptPath: "/tmp/subagent.jsonl",
            result: "Focused tests pass.",
          },
        },
      })
    })

    it("state kinds still hit the badge and never the lifecycle channel", async () => {
      const { ctx, rec } = fakeCtx({ getTask: () => TASK })
      await dispatch("engine.reportEvent", { taskId: "t1", kind: "turn-complete" }, ctx)
      expect(rec.reported.map((r) => r.kind)).toEqual(["turn-complete"])
      expect(rec.published.filter((p) => p.channel === "engine.lifecycle")).toHaveLength(0)
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
    it("registers a pending spawn before a caller-assigned session is pinned", async () => {
      const { ctx, rec } = fakeCtx({ getTask: () => ({ ...TASK, vendor: "claude" }) })
      await dispatch("engine.beginSession", { taskId: "t1", tabId: "tab-claude" }, ctx)
      await dispatch("engine.pinSession", { taskId: "t1", tabId: "tab-claude", sessionId: "session-assigned" }, ctx)
      expect(rec.bindings).toEqual([
        { taskId: "t1", tabId: "tab-claude", vendor: "claude", state: "pending" },
        {
          taskId: "t1",
          tabId: "tab-claude",
          vendor: "claude",
          sessionId: "session-assigned",
          source: "spawn",
        },
      ])
    })

    it("persists a hook-reported native session against the exact tab", async () => {
      const { ctx, rec } = fakeCtx({
        listTasks: () => [TASK],
        getTask: () => ({ ...TASK, vendor: "codex" }),
      })
      await dispatch(
        "engine.reportEvent",
        {
          taskId: "t1",
          tabId: "tab-codex",
          kind: "session-start",
          engine: "codex",
          sessionId: "session-native",
          sessionStartSource: "resume",
          transcriptPath: "/tmp/rollout.jsonl",
        },
        ctx,
      )
      expect(rec.bindings).toContainEqual({
        taskId: "t1",
        tabId: "tab-codex",
        vendor: "codex",
        sessionId: "session-native",
        source: "hook",
        eventKind: "session-start",
        startSource: "resume",
        transcriptPath: "/tmp/rollout.jsonl",
      })
    })

    it("binds an adapter-observed resume before SessionStart fires", async () => {
      const { ctx, rec } = fakeCtx({ getTask: () => ({ ...TASK, vendor: "codex" }) })
      const observeEngineSessionActivation = vi.fn(async () => ({
        phase: "selected" as const,
        sessionId: "session-observed",
        transcriptPath: "/tmp/observed-rollout.jsonl",
        source: "resume" as const,
        observedAt: 1234,
      }))
      ;(ctx as { runtime: DaemonHandlerContext["runtime"] }).runtime = {
        ...ctx.runtime,
        observeEngineSessionActivation,
      }
      await dispatch("engine.beginSession", { taskId: "t1", tabId: "tab-codex", vendor: "codex" }, ctx)
      await expect(
        dispatch("engine.observeSession", { taskId: "t1", tabId: "tab-codex", vendor: "codex", rootPid: 4242 }, ctx),
      ).resolves.toEqual({ observed: true, pending: false, sessionId: "session-observed" })
      expect(observeEngineSessionActivation).toHaveBeenCalledWith("codex", 4242, expect.any(Number))
      expect(rec.bindings.at(-1)).toEqual({
        taskId: "t1",
        tabId: "tab-codex",
        vendor: "codex",
        sessionId: "session-observed",
        source: "observer",
        startSource: "resume",
        transcriptPath: "/tmp/observed-rollout.jsonl",
      })
    })

    it("publishes a transient resume transition before Codex identifies the selected session", async () => {
      const { ctx, rec } = fakeCtx({ getTask: () => ({ ...TASK, vendor: "codex" }) })
      ;(ctx as { runtime: DaemonHandlerContext["runtime"] }).runtime = {
        ...ctx.runtime,
        observeEngineSessionActivation: async () => ({
          phase: "pending",
          source: "resume",
          observedAt: 1_234,
        }),
      }

      await expect(
        dispatch("engine.observeSession", { taskId: "t1", tabId: "tab-codex", vendor: "codex", rootPid: 4242 }, ctx),
      ).resolves.toEqual({ observed: true, pending: true })
      expect(rec.transitions).toEqual([
        {
          taskId: "t1",
          tabId: "tab-codex",
          vendor: "codex",
          startSource: "resume",
          observedAt: 1_234,
        },
      ])
      expect(rec.bindings).toEqual([])
    })

    it("recovers a native session only for a tab-scoped session-start from an older hook reporter", async () => {
      const { ctx, rec } = fakeCtx({
        listTasks: () => [TASK],
        getTask: () => ({ ...TASK, vendor: "codex" }),
      })
      ;(ctx as { runtime: DaemonHandlerContext["runtime"] }).runtime = {
        ...ctx.runtime,
        recoverEngineSession: async () => ({
          sessionId: "session-recovered",
          transcriptPath: "/tmp/recovered-rollout.jsonl",
        }),
      }
      await dispatch(
        "engine.reportEvent",
        { taskId: "t1", tabId: "tab-codex", kind: "session-start", engine: "codex" },
        ctx,
      )
      expect(rec.bindings).toContainEqual({
        taskId: "t1",
        tabId: "tab-codex",
        vendor: "codex",
        sessionId: "session-recovered",
        source: "history-recovery",
        eventKind: "session-start",
        transcriptPath: "/tmp/recovered-rollout.jsonl",
      })
    })

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
      await dispatch(
        "engine.reportEvent",
        { kind: "turn-complete", taskId: "direct", tabId: "tab-3", cwd: TASK.worktreePath },
        ctx,
      )
      expect(rec.reported).toEqual([{ taskId: "direct", kind: "turn-complete", detail: undefined }])
      expect(rec.inboxRecords).toEqual([{ taskId: "direct", kind: "turn-complete", detail: undefined, tabId: "tab-3" }])
    })

    it("an unmatched cwd is silently dropped (returns {} with no report)", async () => {
      const { ctx, rec } = fakeCtx({ listTasks: () => [TASK] })
      await expect(
        dispatch("engine.reportEvent", { kind: "turn-start", cwd: "/somewhere/else" }, ctx),
      ).resolves.toEqual({})
      expect(rec.reported).toEqual([])
      expect(rec.inboxRecords).toEqual([])
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

    // Perf-fix op-count pin (paired with orchestrator/set-active-perf.test.ts):
    // the store's fsync'd doSave was dropped from the focus path, but the
    // `active-task` frame the UI needs must STILL publish 1:1 per switch. Over
    // 10 switches → exactly 10 frames (the win removes disk writes, not frames).
    it("publishes one active-task frame per switch — 10 switches → 10 frames", async () => {
      const { ctx, rec } = fakeCtx({ setActiveTask: async () => {} })
      for (let i = 0; i < 10; i++) {
        await dispatch("task.setActive", { taskId: `t${i % 5}` }, ctx)
      }
      const frames = rec.published.filter((p) => p.channel === "active-task")
      expect(frames).toHaveLength(10)
    })
  })

  // "error shaping" moved to handlers-error-shape.test.ts (file-size cap).
})
