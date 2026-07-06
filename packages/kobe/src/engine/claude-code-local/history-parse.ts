import type { Message } from "@/types/engine"
import { isJsonlLineWithinBound } from "../file-bounds"
import { createAppendParseCache, sortByTimestamp } from "../history-cache"
import { normalizeClaudeContent } from "./normalize"
import { isClaudeCommandBreadcrumb, isSyntheticClaudeRecord } from "./synthetic"

const cache = createAppendParseCache<Message[], string>({
  initial: () => [],
  parseChunk: (chunk, prev, sessionId) => prev.concat(parseJsonl(chunk, sessionId)),
})

export function parseSessionRaw(filePath: string, raw: string, sessionId: string): Message[] {
  return sortByTimestamp(cache(filePath, raw, sessionId))
}

export function parseJsonl(raw: string, sessionId: string): Message[] {
  const out: Message[] = []
  for (const line of raw.split("\n")) {
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
    const msg = extractMessage(parsed, sessionId)
    if (msg) out.push(msg)
  }
  return out
}

function extractMessage(record: Record<string, unknown>, fallbackSessionId: string): Message | null {
  if (isSyntheticClaudeRecord(record)) return null

  const inner = isObject(record.message) ? (record.message as Record<string, unknown>) : record

  const role = inner.role
  if (role !== "user" && role !== "assistant" && role !== "system") return null

  if (!("content" in inner)) return null
  const blocks = normalizeClaudeContent(inner.content)
  if (role === "user" && isClaudeCommandBreadcrumb(blocks)) return null

  const ts = typeof record.timestamp === "string" ? (record.timestamp as string) : new Date().toISOString()
  const sid = typeof record.sessionId === "string" ? (record.sessionId as string) : fallbackSessionId

  const usage = extractUsage(inner.usage)
  return usage
    ? { role, blocks, timestamp: ts, sessionId: sid, usage }
    : { role, blocks, timestamp: ts, sessionId: sid }
}

function extractUsage(v: unknown): Message["usage"] {
  if (!isObject(v)) return undefined
  const inTok = typeof v.input_tokens === "number" ? v.input_tokens : undefined
  const outTok = typeof v.output_tokens === "number" ? v.output_tokens : undefined
  if (inTok === undefined || outTok === undefined) return undefined
  const cacheRead = typeof v.cache_read_input_tokens === "number" ? v.cache_read_input_tokens : undefined
  const cacheCreate = typeof v.cache_creation_input_tokens === "number" ? v.cache_creation_input_tokens : undefined
  return {
    input_tokens: inTok,
    output_tokens: outTok,
    ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreate !== undefined ? { cache_creation_input_tokens: cacheCreate } : {}),
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
