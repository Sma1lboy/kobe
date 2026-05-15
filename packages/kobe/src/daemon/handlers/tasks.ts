/**
 * Task-level CRUD + metadata commands.
 *
 *   - task.list / task.get
 *   - task.spawn (with optional first-prompt auto-run)
 *   - task.archive / task.rename / task.delete / task.pin
 *   - task.permissionMode / task.model
 *   - task.ensureMain (idempotent main-repo task ensure)
 */

import type { DaemonHandler } from "../context.ts"
import {
  objectPayload,
  optionalBoolean,
  optionalModelEffort,
  optionalString,
  optionalVendor,
  requireString,
} from "../payload.ts"
import { serializeTask } from "../protocol.ts"

const taskList: DaemonHandler = async (_req, _client, ctx) => {
  return { tasks: ctx.orch.listTasks().map(serializeTask) }
}

const taskGet: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  const task = ctx.orch.getTask(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  return { task: serializeTask(task) }
}

const taskSpawn: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const repo = requireString(payload, "repo")
  const modelEffort = optionalModelEffort(payload, "modelEffort")
  const vendor = optionalVendor(payload, "vendor")
  const prompt = optionalString(payload, "prompt")
  const task = await ctx.orch.createTask({
    repo,
    prompt,
    title: optionalString(payload, "title"),
    branch: optionalString(payload, "branch"),
    baseRef: optionalString(payload, "baseRef"),
    model: optionalString(payload, "model"),
    modelEffort,
    vendor,
  })
  // Subscribe EVERY attached client to the new task's tabs, not
  // just the spawning client. Otherwise other TUIs see task.created
  // but never receive chat.delta / chat.event for the new task —
  // multi-attach real-time sync silently breaks.
  for (const c of ctx.clients) ctx.subscribeClientToTask(c, task)
  ctx.broadcast({ type: "event", name: "task.created", payload: { task: serializeTask(task) } })
  // If the spawner provided a prompt, kick off the run as
  // fire-and-forget so the RPC returns immediately. Without this
  // an agent calling task.spawn (kobe api spawn-task) gets a task
  // stuck in `backlog` with no worktree, no session, no chat —
  // matches the older MCP bridge semantics (`spawn_task` always
  // ran the task). The TUI's RemoteOrchestrator.spawnTask omits
  // the prompt and uses a separate chat.send for the first
  // message, so this branch is a no-op for it.
  if (prompt) {
    void ctx.orch.runTask(task.id, prompt).catch((err) => {
      // Don't crash the daemon on a spawn-and-run that fails
      // (worktree contention, engine missing, dirty repo). The
      // task still exists; the user can retry from the TUI.
      const msg = err instanceof Error ? err.message : String(err)
      ctx.broadcast({
        type: "event",
        name: "engine.status",
        payload: { taskId: task.id, tabId: task.activeTabId, status: "error", message: msg },
      })
    })
  }
  return { taskId: task.id, task: serializeTask(task) }
}

const taskArchive: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  const archived = optionalBoolean(payload, "archived")
  await ctx.orch.setArchived(taskId, archived)
  const task = ctx.orch.getTask(taskId)
  if (task) {
    ctx.broadcast({ type: "event", name: "task.updated", payload: { taskId, task: serializeTask(task) } })
  }
  return {}
}

const taskRename: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  await ctx.orch.setTitle(taskId, requireString(payload, "title"))
  const task = ctx.orch.getTask(taskId)
  if (task) {
    ctx.broadcast({ type: "event", name: "task.updated", payload: { taskId, task: serializeTask(task) } })
  }
  return {}
}

const taskDelete: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  await ctx.orch.deleteTask(taskId)
  for (const c of ctx.clients) ctx.unsubscribeClientFromTask(c, taskId)
  ctx.broadcast({ type: "event", name: "task.deleted", payload: { taskId } })
  return {}
}

const taskPin: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  await ctx.orch.setPinned(taskId, optionalBoolean(payload, "pinned"))
  ctx.broadcastTaskUpdated(taskId)
  return {}
}

const taskPermissionMode: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  const mode = optionalString(payload, "mode")
  if (mode !== undefined && mode !== "default" && mode !== "plan") throw new Error("mode must be default or plan")
  await ctx.orch.setPermissionMode(taskId, mode)
  ctx.broadcastTaskUpdated(taskId)
  return {}
}

const taskModel: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  const modelEffort = optionalModelEffort(payload, "modelEffort")
  await ctx.orch.setModel(taskId, optionalString(payload, "model"), optionalString(payload, "tabId"), modelEffort)
  ctx.broadcastTaskUpdated(taskId)
  return {}
}

const taskEnsureMain: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const repo = requireString(payload, "repo")
  // Snapshot the pre-call state so we can distinguish (a) fresh
  // creation, (b) unarchive of a previously-removed-from-saved-
  // repos main task, (c) idempotent no-op. Without this, the
  // freshly-created or unarchived task never reaches other
  // attached clients — RemoteOrchestrator's tasksSignal stays
  // stale and the persisted lastSelectedTaskId can resolve to
  // an "archived" main task that the sidebar / auto-select
  // can't see. Mirrors the pattern used by every other task-
  // mutating handler after the subscribeTasks broadcast was
  // dropped.
  const prior = ctx.orch.listTasks().find((t) => t.kind === "main" && t.repo === repo)
  const task = await ctx.orch.ensureMainTask(repo)
  if (!prior) {
    // Fresh main task — subscribe every attached client to its
    // tabs (mirrors task.spawn) then broadcast task.created.
    for (const c of ctx.clients) ctx.subscribeClientToTask(c, task)
    ctx.broadcast({ type: "event", name: "task.created", payload: { task: serializeTask(task) } })
  } else if (prior.archived && !task.archived) {
    // Unarchive path inside ensureMainTask — broadcast as an
    // update so sidebar buckets re-sort the row out of Archives.
    ctx.broadcastTaskUpdated(task.id)
  }
  return { task: serializeTask(task) }
}

export const taskHandlers: Record<string, DaemonHandler> = {
  "task.list": taskList,
  "task.get": taskGet,
  "task.spawn": taskSpawn,
  "task.archive": taskArchive,
  "task.rename": taskRename,
  "task.delete": taskDelete,
  "task.pin": taskPin,
  "task.permissionMode": taskPermissionMode,
  "task.model": taskModel,
  "task.ensureMain": taskEnsureMain,
}
