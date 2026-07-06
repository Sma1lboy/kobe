/**
 * JSONL → Message[] parsing for Claude Code transcripts. The append-aware
 * per-file cache lives in `../history-cache.ts` (shared with the codex and
 * copilot readers); this module supplies the Claude-specific line parser.
 *
 * Soundness of caching here: `parseJsonl` is line-local (no cross-line
 * state), so `parse(prefix) ++ parse(appendedSlice)` reproduces
 * `parse(whole)` exactly, in file order. `sortByTimestamp` then reorders
 * the same objects, so the final array has identical content/order to a
 * full parse, with stable element identities.
 */

import type { Message } from "@/types/engine"
import { isJsonlLineWithinBound } from "../file-bounds"
import { createAppendParseCache, sortByTimestamp } from "../history-cache"
import { normalizeClaudeContent } from "./normalize"
import { isClaudeCommandBreadcrumb, isSyntheticClaudeRecord } from "./synthetic"

const cache = createAppendParseCache<Message[], string>({
  initial: () => [],
  parseChunk: (chunk, prev, sessionId) => prev.concat(parseJsonl(chunk, sessionId)),
})

/**
 * Parse `raw` (the full current contents of `filePath`) into sorted
 * conversation messages, reusing the cached parse of the unchanged prefix
 * when the file only appended since the last call. Message objects for
 * already-seen records keep their identity across calls.
 */
export function parseSessionRaw(filePath: string, raw: string, sessionId: string): Message[] {
  return sortByTimestamp(cache(filePath, raw, sessionId))
}

/**
 * Parse a JSONL blob into the subset of records that look like
 * conversation messages (role + content). Exported for unit testing.
 * Line-local: each line parses independently, so a blob may be parsed
 * in slices and concatenated (the append-cache above relies on this).
 */
export function parseJsonl(raw: string, sessionId: string): Message[] {
  const out: Message[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Skip a pathological mega-line before parsing — same outcome as a
    // malformed line, but without risking a hang in JSON.parse.
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
  // The on-disk shape commonly looks like:
  //   { type: "user"|"assistant", message: { role, content }, timestamp, sessionId }
  // but older records sometimes have role+content at the top level.
  // Drop Claude-injected synthetic rows (local-command caveat, compaction
  // summary) — the flags live on the OUTER record, and Claude's own
  // human-turn/title paths skip exactly these. Without this, a session that
  // opens with a slash/bash command auto-titles from the injected boilerplate.
  if (isSyntheticClaudeRecord(record)) return null

  const inner = isObject(record.message) ? (record.message as Record<string, unknown>) : record

  const role = inner.role
  if (role !== "user" && role !== "assistant" && role !== "system") return null

  if (!("content" in inner)) return null
  // Normalize Claude's vendor shape (string OR content-block array) into
  // the neutral ContentBlock[] surfaced via Message.blocks. Empty arrays
  // are kept so callers can distinguish "message with no renderable
  // content" from "no message" (extractMessage returns null for the latter).
  const blocks = normalizeClaudeContent(inner.content)
  // A `<command-name>…` breadcrumb is a plain (un-flagged) user record Claude
  // writes before the real prompt; drop it so it can't become the title.
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
