/**
 * PR + local-merge flows. Both inject a user prompt into the task's
 * active tab via the orchestrator; the daemon's job is to broadcast
 * the engine-status hint so attached TUIs flip into "running" state.
 */

import type { DaemonHandler } from "../context.ts"
import { objectPayload, requireString } from "../payload.ts"

const prRequest: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  await ctx.orch.requestPR(requireString(payload, "taskId"))
  return {}
}

const localMergeRequest: DaemonHandler = async (req, _client, ctx) => {
  const payload = objectPayload(req.payload)
  const taskId = requireString(payload, "taskId")
  await ctx.orch.requestLocalMerge(taskId)
  const task = ctx.orch.getTask(taskId)
  if (task) {
    ctx.broadcastTaskUpdated(task.id)
    ctx.broadcast({
      type: "event",
      name: "engine.status",
      payload: { taskId: task.id, tabId: task.activeTabId, status: "running" },
    })
  }
  return {}
}

export const prMergeHandlers: Record<string, DaemonHandler> = {
  "pr.request": prRequest,
  "merge.local.request": localMergeRequest,
}
