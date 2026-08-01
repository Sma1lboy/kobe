/** External work-item RPC handlers — read a tracker, start work on one item. */

import { requireString } from "./handler-validators.ts"
import type { DaemonRequestHandler } from "./handlers.ts"
import { startWorkItem } from "./work-item-start.ts"
import { WorkItemError, fetchWorkItem } from "./work-items.ts"

function optionalNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`)
  return value
}

function requireNumberField(payload: Record<string, unknown>, key: string): number {
  const value = optionalNumber(payload, key)
  if (value === undefined) throw new Error(`${key} is required`)
  return value
}

function optionalStringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value.length > 0 ? value : undefined
}

function optionalStringList(payload: Record<string, unknown>, key: string): string[] | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`)
  return value.filter((v): v is string => typeof v === "string" && v.length > 0)
}

/** `gh` failures carry a `kind` naming the fix (install / login / no remote).
 *  Rethrow with it prefixed so the CLI surfaces the actionable half. */
function rethrowWorkItemError(err: unknown): never {
  if (err instanceof WorkItemError) throw new Error(`${err.kind}: ${err.message}`)
  throw err
}

export const WORK_ITEM_HANDLERS: readonly DaemonRequestHandler[] = [
  {
    name: "workitem.list",
    async handle(payload, ctx) {
      const state = optionalStringField(payload, "state")
      try {
        return {
          items: await ctx.workItems.list(
            {
              cwd: requireString(payload, "repo"),
              ...(state === "open" || state === "closed" || state === "all" ? { state } : {}),
              ...(optionalNumber(payload, "limit") !== undefined ? { limit: optionalNumber(payload, "limit") } : {}),
              ...(optionalStringField(payload, "search") ? { search: optionalStringField(payload, "search") } : {}),
              ...(optionalStringField(payload, "assignee")
                ? { assignee: optionalStringField(payload, "assignee") }
                : {}),
              ...(optionalStringList(payload, "labels") ? { labels: optionalStringList(payload, "labels") } : {}),
            },
            payload.refresh === true,
          ),
        }
      } catch (err) {
        rethrowWorkItemError(err)
      }
    },
  },
  {
    name: "workitem.start",
    async handle(payload, ctx) {
      const repo = requireString(payload, "repo")
      const number = requireNumberField(payload, "number")
      // Always re-fetch the single item: the list view omits bodies, and the
      // prompt is only useful with one.
      let item: Awaited<ReturnType<typeof fetchWorkItem>>
      try {
        item = await fetchWorkItem(repo, number)
      } catch (err) {
        rethrowWorkItemError(err)
      }
      const result = await startWorkItem(
        { orch: ctx.orch, runtime: ctx.runtime, link: ctx.selfLink },
        {
          item,
          repo,
          ...(optionalStringField(payload, "vendor") ? { vendor: optionalStringField(payload, "vendor") } : {}),
          ...(optionalStringField(payload, "baseRef") ? { baseRef: optionalStringField(payload, "baseRef") } : {}),
        },
      )
      return {
        taskId: result.task.id,
        title: result.task.title,
        started: result.started,
        linkedWorkItem: { number: item.number, title: item.title, url: item.url },
      }
    },
  },
]
