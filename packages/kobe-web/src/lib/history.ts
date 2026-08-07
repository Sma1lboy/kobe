/**
 * Engine-history client — browser mirrors of the engine's neutral history
 * shapes (packages/kobe/src/types/engine.ts Message / ContentBlock) plus
 * the fetchers for the bridge's /api/history routes and the usage math the
 * transcript header renders. Mirrored locally (like types.ts) so no server
 * code leaks into the client bundle.
 */

import { api } from "./api-client.ts"

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; callId: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; output: unknown; isError: boolean }
  | { type: "thinking"; text: string }

export interface MessageUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface HistoryMessage {
  role: "user" | "assistant" | "system"
  blocks: ContentBlock[]
  timestamp: string
  sessionId: string
  usage?: MessageUsage
}

export interface SessionsResult {
  /** Oldest-first (reader contract) — the latest session is the last entry. */
  sessions: string[]
  /** Newest transcript mtime for the worktree; 0 = none yet. */
  latestMtime: number
}

export function fetchSessions(
  worktreePath: string,
  vendor: string,
): Promise<SessionsResult> {
  return api.get<SessionsResult>("/api/history/sessions", {
    query: { worktreePath, vendor },
    label: "/api/history/sessions",
  })
}

export async function fetchMessages(
  vendor: string,
  sessionId: string,
): Promise<HistoryMessage[]> {
  const { messages } = await api.get<{ messages: HistoryMessage[] }>(
    "/api/history/messages",
    {
      query: { vendor, sessionId },
      label: "/api/history/messages",
    },
  )
  return messages
}

export interface UsageSummary {
  /** Sum of fresh input tokens across the session. */
  inputTokens: number
  /** Sum of output tokens across the session. */
  outputTokens: number
  /** Last assistant turn's full prompt size — the live context estimate
   *  (input + cache read + cache creation), ccstatusline's derivation. */
  contextTokens: number
}

/** Aggregate per-message usage (claude persists it inline; other vendors may
 *  not — all-zero means "no usage data", render nothing). */
export function summarizeUsage(
  messages: readonly HistoryMessage[],
): UsageSummary {
  let inputTokens = 0
  let outputTokens = 0
  let contextTokens = 0
  for (const message of messages) {
    const usage = message.usage
    if (!usage) continue
    inputTokens += usage.input_tokens
    outputTokens += usage.output_tokens
    contextTokens =
      usage.input_tokens +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0)
  }
  return { inputTokens, outputTokens, contextTokens }
}

/** Compact token formatting: 1234 → "1.2k", 1234567 → "1.2m". */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}
