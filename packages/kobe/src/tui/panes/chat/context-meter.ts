import { type SessionUsageMetrics, totalContextTokens } from "../../../session/usage-metrics.ts"
export { totalContextTokens } from "../../../session/usage-metrics.ts"
/**
 * Workspace header "context used" meter — turns the engine's terminal
 * `usage` frame + the active model id into a short string (e.g.
 * `12% · 24k/200k`).
 *
 * Vendor-agnostic: max-context lookup goes through
 * {@link capabilitiesForModelId}, so adding a new vendor only requires
 * registering its capabilities — no edits here.
 */

import { capabilitiesForModelId, getCapabilities } from "@/engine/registry"
import type { VendorId } from "@/types/vendor"

export type UsageSnapshot = SessionUsageMetrics

export function contextWindowTokensForModel(modelId: string | undefined, vendor?: VendorId): number {
  const caps = vendor ? getCapabilities(vendor) : capabilitiesForModelId(modelId)
  const id = modelId ?? caps.defaultModelId()
  return caps.contextWindowFor(id)
}

function formatTokShort(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`
  }
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function formatTotalSpeed(tokensPerSecond: number | undefined): string | null {
  if (typeof tokensPerSecond !== "number" || !Number.isFinite(tokensPerSecond)) return null
  if (tokensPerSecond >= 1000) return `${(tokensPerSecond / 1000).toFixed(1)}k t/s`
  return `${tokensPerSecond.toFixed(1)} t/s`
}

/**
 * Compact label for the WORKSPACE pane header. Returns `null` when totals are zero.
 */
export function formatContextUsageCompact(
  u: UsageSnapshot,
  modelId: string | undefined,
  vendor?: VendorId,
): string | null {
  const caps = vendor ? getCapabilities(vendor) : capabilitiesForModelId(modelId)
  const id = modelId ?? caps.defaultModelId()
  const window = u.context_window_tokens ?? caps.contextWindowFor(id)
  const total = totalContextTokens(u)
  if (total <= 0 || window <= 0) return null
  const pct = Math.min(100, Math.max(0, Math.round((total / window) * 100)))
  const speed = formatTotalSpeed(u.total_speed_tokens_per_second)
  const totalLabel = `${u.context_tokens_approximate ? "~" : ""}${formatTokShort(total)}`
  return [`${pct}% · ${totalLabel}/${formatTokShort(window)}`, speed].filter(Boolean).join(" · ")
}
