import { type SessionUsageMetrics, totalContextTokens } from "../../../session/usage-metrics.ts"
import { resolveDefaultModelId } from "./composer/claude-settings.ts"
export { totalContextTokens } from "../../../session/usage-metrics.ts"
/**
 * Workspace header "context used" meter — turns the engine's terminal
 * `usage` frame + the active model id into a short string (e.g. `12% · 24k/200k`).
 *
 * Context window sizes follow the same `[1m]` long-context convention as
 * {@link MODEL_CHOICES}; unknown model ids fall back to 200k so the meter
 * still renders.
 */
import { MODEL_CHOICES } from "./composer/models.ts"

export type UsageSnapshot = SessionUsageMetrics

const STD_CTX = 200_000

function parseContextWindowSize(modelIdentifier: string): number | null {
  const delimitedMatch = /(?:\(|\[)\s*(\d+(?:[,_]\d+)*(?:\.\d+)?)\s*([km])\s*(?:\)|\])/i.exec(modelIdentifier)
  if (delimitedMatch?.[1] && delimitedMatch[2]) {
    const parsed = Number.parseFloat(delimitedMatch[1].replace(/[,_]/g, ""))
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed * (delimitedMatch[2].toLowerCase() === "m" ? 1_000_000 : 1000))
    }
  }

  const contextMatch = /\b(\d+(?:[,_]\d+)*(?:\.\d+)?)\s*([km])(?:\s*(?:token\s*)?context)?\b/i.exec(modelIdentifier)
  if (!contextMatch?.[1] || !contextMatch[2]) return null

  const parsed = Number.parseFloat(contextMatch[1].replace(/[,_]/g, ""))
  if (!Number.isFinite(parsed) || parsed <= 0) return null

  return Math.round(parsed * (contextMatch[2].toLowerCase() === "m" ? 1_000_000 : 1000))
}

/**
 * Resolve max context tokens for a Claude model id. `[1m]` suffix implies 1M window.
 */
export function contextWindowTokensForModel(modelId: string | undefined): number {
  const id = modelId ?? resolveDefaultModelId()
  const parsedWindow = parseContextWindowSize(id)
  if (parsedWindow !== null) return parsedWindow
  const inPicker = MODEL_CHOICES.some((m) => m.id === id)
  if (inPicker) return STD_CTX
  return STD_CTX
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
export function formatContextUsageCompact(u: UsageSnapshot, modelId: string | undefined): string | null {
  const window = contextWindowTokensForModel(modelId)
  const total = totalContextTokens(u)
  if (total <= 0 || window <= 0) return null
  const pct = Math.min(100, Math.max(0, Math.round((total / window) * 100)))
  const speed = formatTotalSpeed(u.total_speed_tokens_per_second)
  return [`${pct}% · ${formatTokShort(total)}/${formatTokShort(window)}`, speed].filter(Boolean).join(" · ")
}
