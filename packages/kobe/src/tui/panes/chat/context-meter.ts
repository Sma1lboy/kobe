import type { Message } from "../../../types/engine.ts"
import { resolveDefaultModelId } from "./composer/claude-settings.ts"
/**
 * Workspace header "context used" meter — turns the engine's terminal
 * `usage` frame + the active model id into a short string (e.g. `12% · 24k/200k`).
 *
 * Context window sizes follow the same `[1m]` long-context convention as
 * {@link MODEL_CHOICES}; unknown model ids fall back to 200k so the meter
 * still renders.
 */
import { MODEL_CHOICES } from "./composer/models.ts"

export type UsageSnapshot = {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
  readonly total_speed_tokens_per_second?: number
}

type SpeedInterval = {
  startMs: number
  endMs: number
}

/**
 * Sum the tokens that occupy the model's context window on the next turn.
 *
 * The window holds the *prompt* sent to the model, which is the sum of
 * uncached input, cache-creation input, and cache-read input. `output_tokens`
 * is what the model just generated — billable, but not yet "in context"
 * for the meter; folding it in inflates the displayed usage past 100% on
 * heavy turns. This mirrors the canonical Claude Code formula
 * (`refs/claude-code/src/utils/context.ts` `calculateContextPercentages`).
 */
export function totalContextTokens(u: UsageSnapshot): number {
  return u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

function parseTimestampMs(value: string): number | null {
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

function mergeIntervals(intervals: readonly SpeedInterval[]): SpeedInterval[] {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs)
  const first = sorted[0]
  if (!first) return []
  const merged: SpeedInterval[] = [{ startMs: first.startMs, endMs: first.endMs }]

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]
    const last = merged[merged.length - 1]
    if (!current || !last) continue
    if (current.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, current.endMs)
    } else {
      merged.push({ startMs: current.startMs, endMs: current.endMs })
    }
  }

  return merged
}

function durationMs(intervals: readonly SpeedInterval[]): number {
  return intervals.reduce((total, interval) => total + (interval.endMs - interval.startMs), 0)
}

/**
 * Calculate ccstatusline-style total token speed from conversation history.
 *
 * Each assistant usage block is paired with the most recent preceding user
 * timestamp. Duration is active request time, not whole wall-clock session
 * time; overlapping intervals are merged so parallel/subagent work does not
 * double-count elapsed time.
 */
export function deriveUsageMetricsFromHistory(past: readonly Message[]): UsageSnapshot | undefined {
  let latestUsage: UsageSnapshot | undefined
  let latestUsageTimestampMs: number | null = null
  let lastUserTimestampMs: number | null = null
  let inputTokens = 0
  let outputTokens = 0
  const intervals: SpeedInterval[] = []

  for (const message of past) {
    const timestampMs = parseTimestampMs(message.timestamp)
    if (message.role === "user" && timestampMs !== null) {
      lastUserTimestampMs = timestampMs
      continue
    }

    if (message.role !== "assistant" || !message.usage) continue

    if (timestampMs !== null && (latestUsageTimestampMs === null || timestampMs > latestUsageTimestampMs)) {
      latestUsageTimestampMs = timestampMs
      latestUsage = message.usage
    } else if (latestUsage === undefined) {
      latestUsage = message.usage
    }

    inputTokens += message.usage.input_tokens
    outputTokens += message.usage.output_tokens

    if (timestampMs !== null && lastUserTimestampMs !== null && timestampMs > lastUserTimestampMs) {
      intervals.push({ startMs: lastUserTimestampMs, endMs: timestampMs })
    }
  }

  if (!latestUsage) return undefined

  const totalDurationMs = durationMs(mergeIntervals(intervals))
  if (totalDurationMs <= 0) return latestUsage

  return {
    ...latestUsage,
    total_speed_tokens_per_second: (inputTokens + outputTokens) / (totalDurationMs / 1000),
  }
}

export function withTotalSpeedForTurn(
  usage: Omit<UsageSnapshot, "total_speed_tokens_per_second">,
  startedAtIso: string | undefined,
  endedAtIso: string,
): UsageSnapshot {
  const startMs = startedAtIso ? parseTimestampMs(startedAtIso) : null
  const endMs = parseTimestampMs(endedAtIso)
  if (startMs === null || endMs === null || endMs <= startMs) return usage

  return {
    ...usage,
    total_speed_tokens_per_second: (usage.input_tokens + usage.output_tokens) / ((endMs - startMs) / 1000),
  }
}

const LONG_CTX = 1_000_000
const STD_CTX = 200_000

/**
 * Resolve max context tokens for a Claude model id. `[1m]` suffix implies 1M window.
 */
export function contextWindowTokensForModel(modelId: string | undefined): number {
  const id = modelId ?? resolveDefaultModelId()
  if (id.includes("[1m]")) return LONG_CTX
  const inPicker = MODEL_CHOICES.some((m) => m.id === id)
  if (inPicker) return STD_CTX
  if (id.includes("1m") || id.includes("[1M]")) return LONG_CTX
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
