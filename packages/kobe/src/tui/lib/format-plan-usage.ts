/**
 * Compact one-line label for the WORKSPACE pane header.
 *
 * Mirrors `formatContextUsageCompact` in style — short tokens, no fluff —
 * so the two chips read as a single sentence when concatenated with the
 * ` · ` separator used by the topbar.
 */

import type { PlanUsage } from "../../types/plan-usage.ts"

function pct(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return `${Math.round(value)}%`
}

/**
 * `Plan 5h 42% · 7d 18%`, or just one half if the other is missing,
 * or `null` if neither bucket reports a utilization (so the topbar can
 * skip rendering the chip entirely).
 */
export function formatPlanUsageCompact(usage: PlanUsage | null): string | null {
  if (!usage) return null
  const fiveHour = pct(usage.fiveHour?.utilization)
  const sevenDay = pct(usage.sevenDay?.utilization)
  const parts: string[] = []
  if (fiveHour) parts.push(`5h ${fiveHour}`)
  if (sevenDay) parts.push(`7d ${sevenDay}`)
  if (parts.length === 0) return null
  return `Plan ${parts.join(" · ")}`
}
