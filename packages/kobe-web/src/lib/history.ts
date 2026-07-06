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
  sessions: string[]
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
  inputTokens: number
  outputTokens: number
  contextTokens: number
}

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

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}
