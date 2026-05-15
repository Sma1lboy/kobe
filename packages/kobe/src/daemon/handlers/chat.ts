/**
 * Live chat I/O + history paging + subscription.
 *
 *   - chat.sessions / chat.session.open : session catalog + replay
 *   - chat.interrupt / chat.steer       : mid-turn control
 *   - chat.input.pending / chat.input.respond : pending user-input pickup
 *   - chat.history                       : paged message read
 *   - chat.send                          : run a prompt (lazy worktree alloc)
 *   - subscribe                          : attach client to tasks' event buses
 */

import type { Orchestrator } from "../../orchestrator/core.ts"
import type { SessionUsageMetrics } from "../../session/usage-metrics.ts"
import type { Message } from "../../types/engine.ts"
import type { Task } from "../../types/task.ts"
import type { DaemonHandler } from "../context.ts"
import {
  normalizeTaskIds,
  objectPayload,
  optionalNumber,
  optionalString,
  optionalVendor,
  requireString,
  requireUserInputResponse,
} from "../payload.ts"
import { type SerializedHistoryPage, serializeMessages } from "../protocol.ts"

const sessions: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const list = await ctx.orch.listSessions(requireString(payload, "taskId"))
  return { sessions: list }
}

const sessionOpen: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  const tabId = await ctx.orch.openSessionInTab(taskId, requireString(payload, "sessionId"), {
    title: optionalString(payload, "title"),
    vendor: optionalVendor(payload, "vendor"),
  })
  // openSessionInTab appends a new tab; subscribe every attached
  // client to its event bus so live deltas reach them.
  for (const c of ctx.clients) ctx.subscribeClientToTab(c, taskId, tabId)
  ctx.broadcastTaskUpdated(taskId)
  return { tabId }
}

const interrupt: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  await ctx.orch.interruptTask(requireString(payload, "taskId"), optionalString(payload, "tabId"))
  return {}
}

const steer: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  await ctx.orch.steerTask(
    requireString(payload, "taskId"),
    requireString(payload, "text"),
    optionalString(payload, "tabId"),
  )
  return {}
}

const inputPending: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  return { pending: ctx.orch.peekPendingInput(requireString(payload, "taskId")) }
}

const inputRespond: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  await ctx.orch.respondToInput(
    requireString(payload, "taskId"),
    requireString(payload, "requestId"),
    requireUserInputResponse(payload.response),
  )
  return {}
}

const history: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  const sessionId = optionalString(payload, "sessionId")
  const limit = optionalNumber(payload, "limit") ?? 50
  const before = optionalString(payload, "before")
  const result = await readTaskHistory(ctx.orch, taskId, sessionId, limit, before)
  return {
    messages: serializeMessages(result.messages),
    ...(result.usageMetrics ? { usageMetrics: result.usageMetrics } : {}),
    nextBefore: result.nextBefore,
    hasMore: result.hasMore,
  } satisfies SerializedHistoryPage
}

const send: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  const tabId = optionalString(payload, "tabId")
  // Empty / undefined text is a legitimate "continue" / "resume"
  // signal — runTask resumes the existing session without a new
  // user prompt. Earlier code rejected empty text via
  // requireString and the client smuggled a single space (" ") to
  // dodge the check. Now the wire allows undefined.
  const text = optionalString(payload, "text")
  await ctx.orch.runTask(taskId, text, tabId)
  // First-message runs allocate the worktree lazily inside
  // `runTask`: empty `worktreePath` flips to the real path, and
  // `branch` / `status` change too. Without this broadcast, the
  // TUI's RemoteOrchestrator never learns — Files / Terminal
  // panes key off `worktreePath` and stay stuck on the placeholder
  // "no task" state forever. Symptoms: the user types "hi" in a
  // fresh task, sees the worktree-allocated system.info row in
  // chat, but the right column never lights up.
  ctx.broadcastTaskUpdated(taskId)
  const task = ctx.orch.getTask(taskId)
  if (task) {
    ctx.broadcast({
      type: "event",
      name: "engine.status",
      payload: { taskId, tabId: tabId ?? task.activeTabId, status: "running" },
    })
  }
  return {}
}

const subscribe: DaemonHandler = async (req, client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskIds = normalizeTaskIds(payload.taskIds)
  const tasks =
    taskIds === "all"
      ? ctx.orch.listTasks()
      : taskIds.map((id) => ctx.orch.getTask(id)).filter((t): t is Task => Boolean(t))
  for (const task of tasks) ctx.subscribeClientToTask(client, task)
  return {}
}

export const chatHandlers: Record<string, DaemonHandler> = {
  "chat.sessions": sessions,
  "chat.session.open": sessionOpen,
  "chat.interrupt": interrupt,
  "chat.steer": steer,
  "chat.input.pending": inputPending,
  "chat.input.respond": inputRespond,
  "chat.history": history,
  "chat.send": send,
  subscribe,
}

interface TaskHistoryPage {
  messages: Message[]
  usageMetrics?: SessionUsageMetrics
  /**
   * Token the client passes back as `before` to fetch the previous
   * page. `null` when this page already includes the oldest message
   * (no further history) — caller stops paging.
   */
  nextBefore: string | null
  hasMore: boolean
}

async function readTaskHistory(
  orch: Orchestrator,
  taskId: string,
  /**
   * Explicit session id requested by the client (per-tab history
   * load). When omitted we fall back to the task's active-tab
   * sessionId — convenient for callers that only know the taskId.
   * Required for tab-switch correctness: Chat hydrates each tab's
   * scrollback independently, so passing the right sessionId is the
   * difference between "every tab shows the active tab's transcript"
   * and "every tab shows its own."
   */
  requestedSessionId: string | undefined,
  limit: number,
  before?: string,
): Promise<TaskHistoryPage> {
  const task = orch.getTask(taskId)
  const sessionId =
    requestedSessionId ?? task?.tabs.find((t) => t.id === task.activeTabId)?.sessionId ?? task?.sessionId
  if (!sessionId) return { messages: [], nextBefore: null, hasMore: false }
  const { messages, usageMetrics } = await orch.readHistoryWithMetrics(sessionId)
  const beforeIdx = before ? messages.findIndex((m) => `${m.timestamp}:${m.sessionId}` === before) : -1
  const end = beforeIdx >= 0 ? beforeIdx : messages.length
  const start = Math.max(0, end - limit)
  const page = messages.slice(start, end)
  const hasMore = start > 0
  // Echo the oldest message's token so the client can paginate without
  // having to know the wire format. Falls back to null when there are
  // no messages OR when this page already covers the start.
  const first = page[0]
  const nextBefore = hasMore && first ? `${first.timestamp}:${first.sessionId}` : null
  return { messages: page, ...(usageMetrics ? { usageMetrics } : {}), nextBefore, hasMore }
}
