/**
 * Copilot usage-snapshot derivation (KOB-249).
 *
 * The Copilot CLI's `session.shutdown` event carries a `modelMetrics`
 * map (per-model token tallies) plus a `currentTokens` context figure.
 * This collapses that into the neutral {@link EngineUsageSnapshot} the
 * history reader returns, the same way `codex-local/usage.ts` does for
 * Codex. Extracted from the v0.5 Copilot stream adapter that v0.6
 * dropped — the live engine runs in tmux now; we only read its history.
 */

import type { EngineUsageSnapshot } from "@/types/engine"

export function copilotUsageToSnapshot(value: unknown): EngineUsageSnapshot | undefined {
  if (!isObject(value)) return undefined
  const modelMetrics = isObject(value.modelMetrics) ? value.modelMetrics : undefined
  if (!modelMetrics) return undefined
  let input = 0
  let output = 0
  let cached = 0
  for (const metrics of Object.values(modelMetrics)) {
    if (!isObject(metrics) || !isObject(metrics.usage)) continue
    input += numberOr(metrics.usage.inputTokens, 0)
    output += numberOr(metrics.usage.outputTokens, 0)
    cached += numberOr(metrics.usage.cacheReadTokens, 0)
  }
  const context = numberOr(value.currentTokens, 0)
  if (input === 0 && output === 0 && cached === 0 && context === 0) return undefined
  return {
    input_tokens: input,
    output_tokens: output,
    ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
    ...(context > 0 ? { context_tokens: context } : {}),
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}
