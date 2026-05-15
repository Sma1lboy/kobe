/**
 * claude.ai remote-control bridge handlers.
 *
 * Per-tab bridge: callers pass `taskId` so the bridge spawns with
 * `cwd = task.worktreePath` and surfaces the tab's session id in the
 * dialog (so the user can `/resume <sid>` in claude.ai to continue THIS
 * conversation rather than start a fresh one). When `taskId` is omitted
 * (legacy callers, palette command with no active task), we fall back
 * to the git toplevel of the daemon's process cwd — claude.ai still
 * gets a usable environment but bound to no specific session.
 */

import { resolveRepoRoot } from "../../state/repos.ts"
import type { DaemonHandler } from "../context.ts"
import { objectPayload, optionalString } from "../payload.ts"

const start: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = optionalString(payload, "taskId")
  const tabId = optionalString(payload, "tabId")
  let cwd: string
  let bound: { taskId: string; tabId: string; sessionId?: string | null; taskTitle?: string } | undefined
  if (taskId) {
    const task = ctx.orch.getTask(taskId)
    if (!task) throw new Error(`rcBridge.start: unknown taskId ${taskId}`)
    const resolvedTabId = tabId ?? task.activeTabId
    const tab = task.tabs.find((t) => t.id === resolvedTabId)
    if (!tab) throw new Error(`rcBridge.start: unknown tabId ${resolvedTabId} on task ${taskId}`)
    cwd = task.worktreePath
    bound = {
      taskId: task.id,
      tabId: tab.id,
      sessionId: tab.sessionId,
      taskTitle: task.title,
    }
  } else {
    cwd = optionalString(payload, "cwd") ?? resolveRepoRoot(process.cwd())
  }
  if (!cwd) throw new Error("rcBridge.start requires a non-empty cwd")
  const status = await ctx.rcBridge.start({ cwd, bound })
  return { status }
}

const stop: DaemonHandler = async (_req, _client, ctx) => {
  const status = await ctx.rcBridge.stop()
  return { status }
}

const status: DaemonHandler = async (_req, _client, ctx) => {
  return { status: ctx.rcBridge.status() }
}

export const rcBridgeHandlers: Record<string, DaemonHandler> = {
  "rcBridge.start": start,
  "rcBridge.stop": stop,
  "rcBridge.status": status,
}
