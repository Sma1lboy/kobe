/** Automation CRUD + manual-trigger RPC handlers. */

import { runAutomationOnce } from "./automation-runner.ts"
import type { AutomationPatch, AutomationPrecheck } from "./contracts.ts"
import { isValidCron } from "./cron.ts"
import { optionalBoolean, optionalString, optionalVendor, requireString } from "./handler-validators.ts"
import type { DaemonRequestHandler } from "./handlers.ts"

function optionalNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`)
  return value
}

/** Reject an unusable schedule at the boundary — persisting one would leave a
 *  row that can never fire and is only discoverable by watching it not run. */
function requireSchedule(payload: Record<string, unknown>, key: string): string {
  const schedule = requireString(payload, key)
  if (!isValidCron(schedule)) throw new Error(`invalid cron expression: ${schedule}`)
  return schedule
}

/** `null` clears the precheck; absent leaves it untouched. */
function readPrecheck(payload: Record<string, unknown>): AutomationPrecheck | null | undefined {
  if (!("precheck" in payload)) return undefined
  const raw = payload.precheck
  if (raw === null) return null
  if (!raw || typeof raw !== "object") throw new Error("precheck must be an object or null")
  const command = requireString(raw as Record<string, unknown>, "command")
  const timeoutSeconds = optionalNumber(raw as Record<string, unknown>, "timeoutSeconds") ?? 120
  return { command, timeoutSeconds }
}

export const AUTOMATION_HANDLERS: readonly DaemonRequestHandler[] = [
  {
    name: "automation.list",
    web: true,
    async handle(_payload, ctx) {
      const automations = ctx.automations.list()
      return {
        automations,
        // The keep-alive reason, surfaced so `automation-list` explains why the
        // daemon is staying up without a second round-trip.
        keepsDaemonAlive: ctx.automations.hasEnabled(),
      }
    },
  },
  {
    name: "automation.create",
    web: true,
    async handle(payload, ctx) {
      const precheck = readPrecheck(payload)
      const automation = await ctx.automations.create({
        name: requireString(payload, "name"),
        repo: requireString(payload, "repo"),
        prompt: requireString(payload, "prompt"),
        schedule: requireSchedule(payload, "schedule"),
        missedRunGraceMinutes: optionalNumber(payload, "missedRunGraceMinutes") ?? 60,
        ...(optionalVendor(payload, "vendor") ? { vendor: optionalVendor(payload, "vendor") } : {}),
        ...(precheck ? { precheck } : {}),
        ...(optionalString(payload, "baseRef") ? { baseRef: optionalString(payload, "baseRef") } : {}),
        ...(optionalBoolean(payload, "enabled") !== undefined ? { enabled: optionalBoolean(payload, "enabled") } : {}),
      })
      // A new enabled schedule may be the daemon's only reason to stay up.
      ctx.daemon.reevaluateIdle()
      return { automation }
    },
  },
  {
    name: "automation.update",
    web: true,
    async handle(payload, ctx) {
      const id = requireString(payload, "id")
      const patch: AutomationPatch = {
        ...(optionalString(payload, "name") !== undefined ? { name: optionalString(payload, "name") } : {}),
        ...(optionalString(payload, "prompt") !== undefined ? { prompt: optionalString(payload, "prompt") } : {}),
        ...(optionalVendor(payload, "vendor") !== undefined ? { vendor: optionalVendor(payload, "vendor") } : {}),
        ...("schedule" in payload ? { schedule: requireSchedule(payload, "schedule") } : {}),
        ...(readPrecheck(payload) !== undefined ? { precheck: readPrecheck(payload) } : {}),
        ...("baseRef" in payload ? { baseRef: optionalString(payload, "baseRef") ?? null } : {}),
        ...(optionalBoolean(payload, "enabled") !== undefined ? { enabled: optionalBoolean(payload, "enabled") } : {}),
        ...(optionalNumber(payload, "missedRunGraceMinutes") !== undefined
          ? { missedRunGraceMinutes: optionalNumber(payload, "missedRunGraceMinutes") }
          : {}),
      }
      const automation = await ctx.automations.update(id, patch)
      if (!automation) throw new Error(`automation not found: ${id}`)
      // Disabling the last one releases the hold; nothing else would notice.
      ctx.daemon.reevaluateIdle()
      return { automation }
    },
  },
  {
    name: "automation.delete",
    web: true,
    async handle(payload, ctx) {
      const id = requireString(payload, "id")
      const deleted = await ctx.automations.delete(id)
      if (deleted) ctx.daemon.reevaluateIdle()
      return { deleted }
    },
  },
  {
    name: "automation.runs",
    web: true,
    async handle(payload, ctx) {
      const automationId = requireString(payload, "id")
      return { runs: ctx.automations.runsFor(automationId) }
    },
  },
  {
    name: "automation.runNow",
    web: true,
    async handle(payload, ctx) {
      const id = requireString(payload, "id")
      const automation = ctx.automations.get(id)
      if (!automation) throw new Error(`automation not found: ${id}`)
      // `trigger: "manual"` deliberately skips the precheck — the user asking
      // for it IS the answer to "is this worth running".
      const status = await runAutomationOnce(
        { store: ctx.automations, orch: ctx.orch, runtime: ctx.runtime, link: ctx.selfLink },
        automation,
        { scheduledFor: Date.now(), trigger: "manual" },
      )
      return { status }
    },
  },
]
