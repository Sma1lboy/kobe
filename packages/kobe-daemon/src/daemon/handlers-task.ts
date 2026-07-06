import { isTaskStatus } from "@/types/task"
import { logDaemonError } from "./crash-log.ts"
import { optionalBoolean, optionalString, optionalVendor, requireString } from "./handler-validators.ts"
import type { DaemonHandlerContext, DaemonRequestHandler } from "./handlers.ts"
import { serializeTask } from "./protocol.ts"

export const TASK_HANDLERS: readonly DaemonRequestHandler[] = [
  {
    name: "task.list",
    handle(_payload, ctx: DaemonHandlerContext) {
      return { tasks: ctx.orch.listTasks().map(serializeTask) }
    },
  },
  {
    name: "task.get",
    handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      const task = ctx.orch.getTask(taskId)
      if (!task) throw new Error(`task not found: ${taskId}`)
      return { task: serializeTask(task) }
    },
  },
  {
    name: "task.create",
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
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      await ctx.orch.setArchived(taskId, optionalBoolean(payload, "archived"))
      return {}
    },
  },
  {
    name: "task.rename",
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      await ctx.orch.setTitle(taskId, requireString(payload, "title"))
      return {}
    },
  },
  {
    name: "task.setBranch",
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      await ctx.orch.setBranch(taskId, requireString(payload, "branch"))
      return {}
    },
  },
  {
    name: "task.setVendor",
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
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      await ctx.orch.deleteTask(taskId, { force: optionalBoolean(payload, "force") })
      ctx.activity.clearTask(taskId)
      return {}
    },
  },
  {
    name: "task.pin",
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      await ctx.orch.setPinned(taskId, optionalBoolean(payload, "pinned"))
      return {}
    },
  },
  {
    name: "task.move",
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
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      const status = requireString(payload, "status")
      if (!isTaskStatus(status)) throw new Error("status must be a TaskStatus")
      const linked = status === "done" ? ctx.orch.getTask(taskId) : undefined
      const prevStatus = linked?.status
      await ctx.orch.setStatus(taskId, status)
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
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
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
    async handle(payload, ctx) {
      const taskId = optionalString(payload, "taskId") ?? null
      await ctx.orch.setActiveTask(taskId)
      ctx.bus.publish("active-task", { taskId })
      return {}
    },
  },
]
