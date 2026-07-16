/** Durable attention-Inbox RPC handlers. */

import { optionalString, requireNumber, requireString } from "./handler-validators.ts"
import type { DaemonRequestHandler } from "./handlers.ts"

export const ATTENTION_HANDLERS: readonly DaemonRequestHandler[] = [
  {
    name: "attention.dismiss",
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      const tabId = optionalString(payload, "tabId") ?? null
      const at = payload.at === undefined ? undefined : requireNumber(payload, "at")
      return { deleted: await ctx.inbox.deleteEpisode(taskId, tabId, at) }
    },
  },
  {
    name: "attention.read",
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      const tabId = optionalString(payload, "tabId") ?? null
      return { updated: await ctx.inbox.markRead(taskId, tabId, requireNumber(payload, "at")) }
    },
  },
]
