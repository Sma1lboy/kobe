import type { EngineUsageSnapshot } from "@/types/engine"

export function codexUsageToSnapshot(usage: Record<string, unknown>): EngineUsageSnapshot | undefined {
  const totalInput = numberOr(usage.input_tokens, 0)
  const cachedInput = numberOr(usage.cached_input_tokens, 0)
  const output = numberOr(usage.output_tokens, 0)
  const nonCachedInput = Math.max(0, totalInput - cachedInput)

  if (totalInput <= 0 && output <= 0 && cachedInput <= 0) return undefined
  return {
    input_tokens: nonCachedInput,
    output_tokens: output,
    ...(cachedInput > 0 ? { cache_read_input_tokens: cachedInput } : {}),
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}
