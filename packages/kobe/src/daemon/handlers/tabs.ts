/**
 * Chat tab CRUD inside a task.
 *
 *   - chat.tab.create / chat.tab.close / chat.tab.activate
 *   - chat.tab.rename / chat.tab.clear
 */

import type { DaemonHandler } from "../context.ts"
import { objectPayload, optionalString, requireString } from "../payload.ts"

const tabCreate: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  const tab = await ctx.orch.createTab(taskId, { title: optionalString(payload, "title") })
  // Subscribe EVERY client to JUST the new tab. Subscribing the
  // whole task again would re-add a listener for every existing
  // tab on every create — N tabs ⇒ N redundant callbacks per
  // delta. Per-tab + dedupe (the Map key) prevents that leak.
  for (const c of ctx.clients) ctx.subscribeClientToTab(c, taskId, tab.id)
  ctx.broadcastTaskUpdated(taskId)
  return { tab }
}

const tabClose: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  const nextActive = await ctx.orch.closeTab(taskId, requireString(payload, "tabId"))
  ctx.broadcastTaskUpdated(taskId)
  return { nextActive }
}

const tabActivate: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  await ctx.orch.setActiveTab(taskId, requireString(payload, "tabId"))
  ctx.broadcastTaskUpdated(taskId)
  return {}
}

const tabRename: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  await ctx.orch.setTabTitle(taskId, requireString(payload, "tabId"), requireString(payload, "title"))
  ctx.broadcastTaskUpdated(taskId)
  return {}
}

const tabClear: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  await ctx.orch.clearTab(taskId, requireString(payload, "tabId"))
  // Broadcast the task delta too — `clearTab` dropped the tab's
  // sessionId, so any attached TUI's tab list mirror needs the
  // refresh to reflect the new "fresh tab" state alongside the
  // `chat.tab.cleared` event that resets the reducer.
  ctx.broadcastTaskUpdated(taskId)
  return {}
}

export const tabHandlers: Record<string, DaemonHandler> = {
  "chat.tab.create": tabCreate,
  "chat.tab.close": tabClose,
  "chat.tab.activate": tabActivate,
  "chat.tab.rename": tabRename,
  "chat.tab.clear": tabClear,
}
