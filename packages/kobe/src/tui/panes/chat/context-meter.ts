/**
 * Workspace header "context used" meter — turns the engine's terminal
 * `usage` frame + the active model id into a short string (e.g.
 * `12% · 24k/200k`).
 *
 * Vendor-agnostic: max-context lookup goes through
 * {@link capabilitiesForModelId}, so adding a new vendor only requires
 * registering its capabilities — no edits here.
 */

import { capabilitiesForModelId } from "@/engine/registry"

export type UsageSnapshot = {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
}

/** Sum billed tokens that occupy context (matches common API usage breakdown). */
export function totalContextTokens(u: UsageSnapshot): number {
  return u.input_tokens + u.output_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
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

/**
 * Compact label for the WORKSPACE pane header. Returns `null` when totals are zero.
 */
export function formatContextUsageCompact(u: UsageSnapshot, modelId: string | undefined): string | null {
  const caps = capabilitiesForModelId(modelId)
  const id = modelId ?? caps.defaultModelId()
  const window = caps.contextWindowFor(id)
  const total = totalContextTokens(u)
  if (total <= 0 || window <= 0) return null
  const pct = Math.min(100, Math.max(0, Math.round((total / window) * 100)))
  return `${pct}% · ${formatTokShort(total)}/${formatTokShort(window)}`
}
