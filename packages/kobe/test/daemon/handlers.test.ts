import { EngineEventLog } from "@sma1lboy/kobe-daemon/daemon/engine-events-log"
import { PromptBroker } from "@sma1lboy/kobe-daemon/daemon/prompt-broker"
import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { createDaemonHandlerRegistry } from "@sma1lboy/kobe-daemon/daemon/server"
import { describe, expect, it } from "vitest"
import { TASK, dispatch, fakeCtx } from "./handler-test-context.ts"

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
 *
 * Task CRUD, the issue store, and the worktree verbs live in the sibling
 * `handlers-task-crud.test.ts` (this file hit the 500-line cap).
 */

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
      "debug.inspect",
      "ui.reportEvent",
      "ui.prompt",
      "ui.promptReply",
      "tab.open",
      "tab.close",
      "notice.send",
      "note.file",
      "note.list",
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

  describe("engine.reportEvent lifecycle kinds", () => {
    it("buffers every kind, publishes engine.lifecycle for low-frequency ones, and skips the badge", async () => {
      const { ctx, rec } = fakeCtx({ getTask: () => TASK })
      const log = new EngineEventLog()
      ;(ctx as { engineEvents?: EngineEventLog }).engineEvents = log
      await dispatch("engine.reportEvent", { taskId: "t1", kind: "pre-compact" }, ctx)
      await dispatch("engine.reportEvent", { taskId: "t1", kind: "tool-post", detail: { tool: { name: "Bash" } } }, ctx)
      // Lifecycle-only kinds never touch the activity badge or the inbox.
      expect(rec.reported).toHaveLength(0)
      expect(rec.inboxRecords).toHaveLength(0)
      // Only the low-frequency kind broadcast on engine.lifecycle (no tool spam).
      const lifecycle = rec.published.filter((p) => p.channel === "engine.lifecycle")
      expect(lifecycle).toHaveLength(1)
      expect(lifecycle[0]?.payload).toMatchObject({ taskId: "t1", kind: "pre-compact" })
      // Both kinds landed in the recent-events buffer, readable over RPC.
      const res = (await dispatch("task.recentEvents", { taskId: "t1" }, ctx)) as { events: { kind: string }[] }
      expect(res.events.map((e) => e.kind)).toEqual(["pre-compact", "tool-post"])
    })

    it("state kinds still hit the badge and never the lifecycle channel", async () => {
      const { ctx, rec } = fakeCtx({ getTask: () => TASK })
      await dispatch("engine.reportEvent", { taskId: "t1", kind: "turn-complete" }, ctx)
      expect(rec.reported.map((r) => r.kind)).toEqual(["turn-complete"])
      expect(rec.published.filter((p) => p.channel === "engine.lifecycle")).toHaveLength(0)
    })
  })

  describe("tab.close", () => {
    it("publishes a tab.close event for a known task and rejects an unknown one", async () => {
      const { ctx, rec } = fakeCtx({ getTask: (id: string) => (id === "t1" ? TASK : undefined) })
      const before = Date.now()
      const result = await dispatch("tab.close", { taskId: "t1", title: "demo" }, ctx)
      expect(result).toEqual({ ok: true })
      const event = rec.published[0] as { channel: string; payload: Record<string, unknown> }
      expect(event.channel).toBe("tab.close")
      expect(event.payload).toMatchObject({ taskId: "t1", title: "demo" })
      expect(event.payload.at as number).toBeGreaterThanOrEqual(before)
      const { ctx: ctx2 } = fakeCtx({ getTask: () => undefined })
      await expect(dispatch("tab.close", { taskId: "nope", title: "t" }, ctx2)).rejects.toThrow(/task not found/)
    })

    it("carries an explicit tabId through (pane-close --tab)", async () => {
      const { ctx, rec } = fakeCtx({ getTask: () => TASK })
      await dispatch("tab.close", { taskId: "t1", title: "demo", tabId: "tab-3" }, ctx)
      const event = rec.published[0] as { payload: Record<string, unknown> }
      expect(event.payload.tabId).toBe("tab-3")
    })
  })

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

    it("carries a valid direction and drops an unknown one", async () => {
      const { ctx, rec } = fakeCtx({ getTask: () => TASK })
      await dispatch("tab.open", { taskId: "t1", argv: ["x"], title: "t", direction: "down" }, ctx)
      await dispatch("tab.open", { taskId: "t1", argv: ["x"], title: "t", direction: "sideways" }, ctx)
      const [down, bogus] = rec.published as { payload: Record<string, unknown> }[]
      expect(down.payload.direction).toBe("down")
      expect(bogus.payload.direction).toBeUndefined()
    })

    it("carries an explicit tabId through (pane-open --tab)", async () => {
      const { ctx, rec } = fakeCtx({ getTask: () => TASK })
      await dispatch("tab.open", { taskId: "t1", argv: ["x"], title: "t", tabId: "tab-3" }, ctx)
      const event = rec.published[0] as { payload: Record<string, unknown> }
      expect(event.payload.tabId).toBe("tab-3")
    })
  })

  describe("session.deliver", () => {
    it("publishes with an explicit tabId and rejects an unknown task", async () => {
      const { ctx, rec } = fakeCtx({ getTask: (id: string) => (id === "t1" ? TASK : undefined) })
      const result = await dispatch("session.deliver", { taskId: "t1", text: "hi", tabId: "tab-2" }, ctx)
      expect(result).toEqual({ ok: true })
      const event = rec.published[0] as { channel: string; payload: Record<string, unknown> }
      expect(event.channel).toBe("session.deliver")
      expect(event.payload).toMatchObject({ taskId: "t1", text: "hi", tabId: "tab-2", source: "dispatcher" })
      const { ctx: ctx2 } = fakeCtx({ getTask: () => undefined })
      await expect(dispatch("session.deliver", { taskId: "nope", text: "x" }, ctx2)).rejects.toThrow(/task not found/)
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
