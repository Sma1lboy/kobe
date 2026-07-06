import type { ContentBlock } from "@/types/content"
import type { EngineHistory, EngineUsageSnapshot, Message } from "@/types/engine"
import { isJsonlLineWithinBound } from "../file-bounds"
import { createAppendParseCache, sortByTimestamp } from "../history-cache"
import { normalizeCodexContent } from "./normalize"
import { isSyntheticCodexUserRow } from "./synthetic"
import { codexUsageToSnapshot } from "./usage"

interface CodexParseState {
  readonly messages: Message[]
  readonly latestUsage: EngineUsageSnapshot | undefined
  readonly latestUsageTimestampMs: number | null
}

const emptyState: CodexParseState = { messages: [], latestUsage: undefined, latestUsageTimestampMs: null }

const cache = createAppendParseCache<CodexParseState, string>({
  initial: () => emptyState,
  parseChunk: foldRolloutChunk,
})

export function parseRolloutRaw(filePath: string, raw: string, sessionId: string): EngineHistory {
  const state = cache(filePath, raw, sessionId)
  const messages = sortByTimestamp(state.messages)
  return { messages, ...(state.latestUsage ? { usageMetrics: state.latestUsage } : {}) }
}

export function parseJsonl(raw: string, sessionId: string): Message[] {
  return foldRolloutChunk(raw, emptyState, sessionId).messages
}

export function deriveCodexUsageMetrics(raw: string): EngineUsageSnapshot | undefined {
  return foldRolloutChunk(raw, emptyState, "").latestUsage
}

function foldRolloutChunk(chunk: string, prev: CodexParseState, sessionId: string): CodexParseState {
  const messages = prev.messages.slice()
  let latestUsage = prev.latestUsage
  let latestUsageTimestampMs = prev.latestUsageTimestampMs

  for (const line of chunk.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (!isJsonlLineWithinBound(trimmed)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isObject(parsed)) continue

    if (parsed.type === "response_item") {
      const payload = isObject(parsed.payload) ? parsed.payload : undefined
      if (!payload) continue
      const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString()
      const msg = normalizeCodexResponseItem(payload, ts, sessionId)
      if (msg) messages.push(msg)
      continue
    }

    if (parsed.type !== "turn.completed") continue
    const usage = isObject(parsed.usage) ? parsed.usage : undefined
    if (!usage) continue
    const snapshot = codexUsageToSnapshot(usage)
    if (!snapshot) continue
    const timestampMs = typeof parsed.timestamp === "string" ? parseTimestampMs(parsed.timestamp) : null
    if (timestampMs !== null && (latestUsageTimestampMs === null || timestampMs > latestUsageTimestampMs)) {
      latestUsageTimestampMs = timestampMs
      latestUsage = snapshot
    } else if (latestUsageTimestampMs === null) {
      latestUsage = snapshot
    }
  }

  return { messages, latestUsage, latestUsageTimestampMs }
}

function normalizeCodexResponseItem(
  payload: Record<string, unknown>,
  timestamp: string,
  sessionId: string,
): Message | undefined {
  if (payload.type === "message") {
    const role = payload.role
    if (role !== "user" && role !== "assistant" && role !== "system") return undefined
    const blocks = normalizeCodexContent(payload.content)
    if (role === "user" && isSyntheticCodexUserRow(blocks)) return undefined
    return { role, blocks, timestamp, sessionId }
  }

  if (payload.type === "reasoning") return normalizeCodexReasoning(payload, timestamp, sessionId)

  if (payload.type === "function_call") {
    return normalizeCodexToolCall(payload, timestamp, sessionId, {
      name: stringOr(payload.name, "function_call"),
      input: parseMaybeJson(payload.arguments),
    })
  }
  if (payload.type === "custom_tool_call") {
    return normalizeCodexToolCall(payload, timestamp, sessionId, {
      name: stringOr(payload.name, "custom_tool_call"),
      input: parseMaybeJson(payload.input),
    })
  }
  if (payload.type === "tool_search_call") {
    return normalizeCodexToolCall(payload, timestamp, sessionId, {
      name: "tool_search_call",
      input: stripPayload(payload, ["type", "call_id", "status"]),
    })
  }

  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    return normalizeCodexToolResult(payload, timestamp, sessionId, parseMaybeJson(payload.output))
  }
  if (payload.type === "tool_search_output") {
    return normalizeCodexToolResult(payload, timestamp, sessionId, stripPayload(payload, ["type", "call_id"]))
  }

  if (
    payload.type === "web_search_call" ||
    payload.type === "image_generation_call" ||
    payload.type === "local_shell_call"
  ) {
    return normalizeSingleRecordTool(payload, timestamp, sessionId)
  }

  return undefined
}

function normalizeCodexReasoning(
  payload: Record<string, unknown>,
  timestamp: string,
  sessionId: string,
): Message | undefined {
  const text = reasoningTextFromItem(payload)
  if (text.length === 0) return undefined
  return { role: "assistant", blocks: [{ type: "thinking", text }], timestamp, sessionId }
}

function normalizeCodexToolCall(
  payload: Record<string, unknown>,
  timestamp: string,
  sessionId: string,
  args: { readonly name: string; readonly input: unknown },
): Message | undefined {
  const callId = typeof payload.call_id === "string" ? payload.call_id : undefined
  if (!callId) return undefined
  const block: ContentBlock = {
    type: "tool_call",
    callId,
    name: args.name,
    input: args.input,
  }
  return { role: "assistant", blocks: [block], timestamp, sessionId }
}

function normalizeCodexToolResult(
  payload: Record<string, unknown>,
  timestamp: string,
  sessionId: string,
  output: unknown,
): Message | undefined {
  const callId = typeof payload.call_id === "string" ? payload.call_id : undefined
  if (!callId) return undefined
  const block: ContentBlock = {
    type: "tool_result",
    callId,
    output,
    isError: false,
  }
  return { role: "user", blocks: [block], timestamp, sessionId }
}

function normalizeSingleRecordTool(
  payload: Record<string, unknown>,
  timestamp: string,
  sessionId: string,
): Message | undefined {
  const type = typeof payload.type === "string" ? payload.type : "tool"
  const callId =
    typeof payload.call_id === "string" && payload.call_id.length > 0 ? payload.call_id : `${type}:${timestamp}`
  const name = stringOr(payload.name, type)
  const input = stripPayload(payload, ["type", "call_id", "status"])
  const output = stripPayload(payload, ["type", "call_id"])
  return {
    role: "assistant",
    timestamp,
    sessionId,
    blocks: [
      { type: "tool_call", callId, name, input },
      { type: "tool_result", callId, output, isError: false },
    ],
  }
}

function reasoningTextFromItem(item: Record<string, unknown>): string {
  const content = textFromReasoningValue(item.content)
  if (content.length > 0) return content
  const text = typeof item.text === "string" ? item.text : ""
  if (text.length > 0) return text
  return textFromReasoningValue(item.summary)
}

function textFromReasoningValue(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  const parts: string[] = []
  for (const entry of value) {
    if (typeof entry === "string") {
      parts.push(entry)
      continue
    }
    if (!isObject(entry)) continue
    const text = typeof entry.text === "string" ? entry.text : ""
    if (text.length > 0) parts.push(text)
  }
  return parts.join("")
}

function stripPayload(payload: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (!keys.includes(key)) out[key] = value
  }
  return out
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function parseTimestampMs(value: string): number | null {
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
