/** Durable attention-Inbox RPC handlers. */

import { optionalString, requireString } from "./handler-validators.ts"
import type { DaemonRequestHandler } from "./handlers.ts"

export const ATTENTION_HANDLERS: readonly DaemonRequestHandler[] = [
  {
    name: "attention.dismiss",
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      const tabId = optionalString(payload, "tabId") ?? null
      return { deleted: await ctx.inbox.deleteEpisode(taskId, tabId) }
    },
  },
]
