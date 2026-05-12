import type { Message } from "../types/engine.ts"

export type SessionUsageMetrics = {
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
 * The window holds the prompt sent to the model: uncached input plus prompt
 * cache creation/read tokens. `output_tokens` is billable, but it is not part
 * of the next prompt-side context meter; including it inflated kobe's display
 * on large assistant turns.
 */
export function totalContextTokens(u: SessionUsageMetrics): number {
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
 * Calculate ccstatusline-style usage metrics from a Session history.
 *
 * The context value comes from the latest assistant usage block. The speed
 * value is a session-average over active request time: pair each assistant
 * usage block with the most recent preceding user timestamp, sum input+output
 * tokens, merge overlapping intervals, then divide tokens by active seconds.
 */
export function deriveSessionUsageMetrics(past: readonly Message[]): SessionUsageMetrics | undefined {
  let latestUsage: SessionUsageMetrics | undefined
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
  usage: Omit<SessionUsageMetrics, "total_speed_tokens_per_second">,
  startedAtIso: string | undefined,
  endedAtIso: string,
): SessionUsageMetrics {
  const startMs = startedAtIso ? parseTimestampMs(startedAtIso) : null
  const endMs = parseTimestampMs(endedAtIso)
  if (startMs === null || endMs === null || endMs <= startMs) return usage

  return {
    ...usage,
    total_speed_tokens_per_second: (usage.input_tokens + usage.output_tokens) / ((endMs - startMs) / 1000),
  }
}
