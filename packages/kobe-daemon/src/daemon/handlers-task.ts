/**
 * `task.*` (+ `project.forget`) daemon RPC handlers — split out of
 * `handlers.ts` (which was over the repo's 500-line file-size cap) purely
 * mechanically: same entries, same behavior, moved verbatim. See
 * `handlers.ts`'s doc comment for the registry's wire-compatibility
 * contract (byte-equivalent payloads, key order load-bearing) — unchanged
 * here.
 */

import { isTaskStatus } from "@/types/task"
import { logDaemonError } from "./crash-log.ts"
import { optionalBoolean, optionalString, optionalVendor, requireString } from "./handler-validators.ts"
import type { DaemonHandlerContext, DaemonRequestHandler } from "./handlers.ts"
import { serializeTask } from "./protocol.ts"

export const TASK_HANDLERS: readonly DaemonRequestHandler[] = [
  {
    name: "task.list",
    web: true,
    handle(_payload, ctx: DaemonHandlerContext) {
      return { tasks: ctx.orch.listTasks().map(serializeTask) }
    },
  },
  {
    name: "task.get",
    web: true,
    handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      const task = ctx.orch.getTask(taskId)
      if (!task) throw new Error(`task not found: ${taskId}`)
      return { task: serializeTask(task) }
    },
  },
  {
    name: "task.create",
    web: true,
    async handle(payload, ctx) {
      const repo = requireString(payload, "repo")
      const task = await ctx.orch.createTask({
        repo,
        title: optionalString(payload, "title"),
        branch: optionalString(payload, "branch"),
        baseRef: optionalString(payload, "baseRef"),
        vendor: optionalVendor(payload, "vendor"),
        modelEffort: optionalString(payload, "effort"),
      })
      return { taskId: task.id, task: serializeTask(task) }
    },
  },
  {
    name: "task.archive",
    web: true,
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      await ctx.orch.setArchived(taskId, optionalBoolean(payload, "archived"))
      return {}
    },
  },
  {
    name: "task.rename",
    web: true,
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      await ctx.orch.setTitle(taskId, requireString(payload, "title"))
      return {}
    },
  },
  {
    name: "task.setBranch",
    web: true,
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      await ctx.orch.setBranch(taskId, requireString(payload, "branch"))
      return {}
    },
  },
  {
    name: "task.setVendor",
    web: true,
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      const vendor = optionalVendor(payload, "vendor")
      if (!vendor) throw new Error("task.setVendor: vendor is required")
      await ctx.orch.setVendor(taskId, vendor)
      return {}
    },
  },
  {
    name: "task.delete",
    web: true,
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      await ctx.orch.deleteTask(taskId, { force: optionalBoolean(payload, "force") })
      ctx.activity.clearTask(taskId)
      return {}
    },
  },
  {
    name: "task.pin",
    web: true,
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      await ctx.orch.setPinned(taskId, optionalBoolean(payload, "pinned"))
      return {}
    },
  },
  {
    name: "task.move",
    web: true,
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      const direction = requireString(payload, "direction")
      if (direction !== "up" && direction !== "down") throw new Error("direction must be up or down")
      await ctx.orch.moveTask(taskId, direction === "up" ? -1 : 1)
      return {}
    },
  },
  {
    name: "task.status",
    web: true,
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      const status = requireString(payload, "status")
      if (!isTaskStatus(status)) throw new Error("status must be a TaskStatus")
      // Capture the task (for repo) AND its prior status BEFORE the
      // transition so we can mirror a real task→done transition into the
      // issue store below.
      const linked = status === "done" ? ctx.orch.getTask(taskId) : undefined
      const prevStatus = linked?.status
      await ctx.orch.setStatus(taskId, status)
      // Done-mirroring: a task reaching `done` flips its source issue to
      // `done` too, so a unified board stays consistent. The reverse-look-up
      // (issue owns the link via `Issue.taskId`) and the conditional flip run
      // atomically inside the issue store under one lock — so a concurrent
      // reopen from another surface can't be clobbered by a stale read.
      // Guarded to an ACTUAL →done transition (prevStatus !== "done", so
      // re-firing done on an already-done task never re-clobbers a
      // manually-reopened issue); the issue write must never fail the task
      // update (the status change already committed), so a missing/raced
      // issue is logged + swallowed.
      if (status === "done" && prevStatus !== "done" && linked) {
        try {
          const next = await ctx.issues.mirrorTaskDone(linked.repo, taskId)
          if (next) ctx.bus.publish("issue.snapshot", next)
        } catch (err) {
          logDaemonError("issue-done-mirror", err)
        }
      }
      return {}
    },
  },
  {
    name: "task.reorder",
    web: true,
    async handle(payload, ctx) {
      const moves = payload.moves
      if (!Array.isArray(moves) || moves.length === 0) throw new Error("moves must be a non-empty array")
      if (moves.length > 500) throw new Error("too many moves in one task.reorder batch (max 500)")
      const parsed = moves.map((move) => {
        if (typeof move !== "object" || move === null) throw new Error("each move needs taskId and position")
        const entry = move as Record<string, unknown>
        const taskId = requireString(entry, "taskId")
        const position = entry.position
        if (typeof position !== "number" || !Number.isFinite(position)) {
          throw new Error("position must be a finite number")
        }
        return { taskId, position }
      })
      await ctx.orch.reorderTasks(parsed)
      return {}
    },
  },
  {
    name: "task.ensureMain",
    web: true,
    async handle(payload, ctx) {
      const repo = requireString(payload, "repo")
      const task = await ctx.orch.ensureMainTask(repo)
      return { task: serializeTask(task) }
    },
  },
  {
    name: "project.forget",
    async handle(payload, ctx) {
      const repo = requireString(payload, "repo")
      await ctx.orch.forgetProject(repo)
      return {}
    },
  },
  {
    name: "task.ensureWorktree",
    web: true,
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      // Long-operation feedback (issue #5): `git worktree add` is
      // minute-class on a huge repo, and the RPC stays BLOCKING (callers
      // need the path to build the tmux session) — so publish lifecycle
      // progress on the `task.jobs` channel around the call. Every
      // attached Tasks pane shows a "materializing" row state, not just
      // the initiating client. A terminal phase (`done`/`error`) is
      // published ALWAYS, including on throw — otherwise the bus's
      // last-value replay would show late subscribers a stuck `running`
      // forever. Fast paths (already-materialised worktree, `main`
      // tasks) publish running→done back-to-back, which clients fold
      // into a no-op blink at worst. The error message rides along for
      // UI hints; the RPC error itself still reaches the caller via the
      // rethrow.
      ctx.bus.publish("task.jobs", { taskId, kind: "ensureWorktree", phase: "running" })
      try {
        const path = await ctx.orch.ensureWorktree(taskId)
        ctx.bus.publish("task.jobs", { taskId, kind: "ensureWorktree", phase: "done" })
        return { worktreePath: path }
      } catch (err) {
        ctx.bus.publish("task.jobs", {
          taskId,
          kind: "ensureWorktree",
          phase: "error",
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },
  },
  {
    name: "task.setActive",
    web: true,
    async handle(payload, ctx) {
      // UI/session focus lives on the bus, but setting it also touches the
      // task's updatedAt so "recent" task sorting reflects actual use.
      // Publishing caches the last value so a late-subscribing Tasks pane
      // gets the current focus on connect and every pane highlights the
      // same active task.
      const taskId = optionalString(payload, "taskId") ?? null
      await ctx.orch.setActiveTask(taskId)
      ctx.bus.publish("active-task", { taskId })
      return {}
    },
  },
]
