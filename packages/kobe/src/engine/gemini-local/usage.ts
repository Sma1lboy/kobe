import type { EngineUsageSnapshot } from "@/types/engine"

export function geminiStatsToSnapshot(stats: unknown): EngineUsageSnapshot | undefined {
  if (!isObject(stats)) return undefined
  const inputTokens = numberOr(stats.input_tokens, numberOr(stats.inputTokens, 0))
  const outputTokens = numberOr(stats.output_tokens, numberOr(stats.outputTokens, 0))
  const cached = numberOr(stats.cached, 0)
  const total = numberOr(stats.total_tokens, numberOr(stats.totalTokens, 0))

  let input = inputTokens
  let output = outputTokens
  let cacheRead = cached
  if (input === 0 && output === 0 && isObject(stats.models)) {
    for (const modelStats of Object.values(stats.models)) {
      if (!isObject(modelStats)) continue
      input += numberOr(modelStats.input_tokens, numberOr(modelStats.inputTokens, 0))
      output += numberOr(modelStats.output_tokens, numberOr(modelStats.outputTokens, 0))
      cacheRead += numberOr(modelStats.cached, 0)
    }
  }

  if (input === 0 && output === 0 && total === 0 && cacheRead === 0) return undefined
  return {
    input_tokens: Math.max(0, input - cacheRead),
    output_tokens: output,
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
    ...(total > 0 ? { context_tokens: total, context_tokens_approximate: false } : {}),
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
