/**
 * JSONL → Message[] parsing for Claude Code transcripts, plus an
 * append-aware per-file cache so repeated `readHistory` polls don't
 * re-parse the whole session every 2.5s tick.
 *
 * Why the cache exists: the history pane polls transcript mtime and calls
 * `readHistory` on every change. A full re-parse builds a completely fresh
 * `Message[]` with new object identities each call — Solid's `<For>` keys
 * rows by reference, so all-new identities destroy + recreate every rendered
 * row's native subtree per poll, and the re-parse itself is O(n²) allocation
 * over a session's lifetime. Transcripts are append-only in the common case,
 * so we cache the parsed prefix and only parse the appended slice, returning
 * the SAME message object refs for already-seen records.
 *
 * Soundness: `parseJsonl` is line-local (no cross-line state), so
 * `parse(prefix) ++ parse(appendedSlice)` reproduces `parse(whole)` exactly,
 * in file order. The cache boundary always sits on a `\n` so a partially
 * flushed trailing line is never split across prefix/suffix — the
 * un-terminated tail is re-parsed fresh every call and never cached.
 * `sortByTimestamp` then reorders the same objects, so the final array has
 * identical content/order to a full parse, with stable element identities.
 *
 * Rewrite/truncation (compaction, resume-branch rewrites) is detected by
 * validating the cached prefix: previous prefix length + a SHA-256 of that
 * prefix (we never retain the previous file content itself). Any mismatch
 * falls back to a full re-parse and replaces the cache entry.
 */

import { createHash } from "node:crypto"
import type { Message } from "@/types/engine"
import { isJsonlLineWithinBound } from "../file-bounds"
import { normalizeClaudeContent } from "./normalize"
import { isClaudeCommandBreadcrumb, isSyntheticClaudeRecord } from "./synthetic"

interface CacheEntry {
  /** Char length of the cached prefix — always ends at a `\n` boundary. */
  prefixLength: number
  /** SHA-256 hex of `raw.slice(0, prefixLength)` at cache time. */
  prefixHash: string
  /** Messages parsed from that prefix, in file order (pre-sort). */
  messages: Message[]
}

// ponytail: FIFO cap, not LRU — a pane process only ever polls a handful of
// session files; switch to LRU if panes start juggling many sessions.
const MAX_CACHED_FILES = 8
const cache = new Map<string, CacheEntry>()

function hashPrefix(raw: string, length: number): string {
  return createHash("sha256").update(raw.slice(0, length)).digest("hex")
}

function remember(filePath: string, entry: CacheEntry): void {
  cache.delete(filePath) // re-insert so Map order tracks recency of writes
  cache.set(filePath, entry)
  if (cache.size > MAX_CACHED_FILES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

/**
 * Parse `raw` (the full current contents of `filePath`) into sorted
 * conversation messages, reusing the cached parse of the unchanged prefix
 * when the file only appended since the last call. Message objects for
 * already-seen records keep their identity across calls.
 */
export function parseSessionRaw(filePath: string, raw: string, sessionId: string): Message[] {
  // Complete-line boundary: everything past the last `\n` may be a
  // partially flushed record — parse it fresh each call, never cache it.
  const stableLength = raw.lastIndexOf("\n") + 1
  const entry = cache.get(filePath)

  let prefixMessages: Message[]
  if (entry && entry.prefixLength <= stableLength && hashPrefix(raw, entry.prefixLength) === entry.prefixHash) {
    // Append-only since last read: parse just the new complete lines.
    prefixMessages =
      entry.prefixLength < stableLength
        ? entry.messages.concat(parseJsonl(raw.slice(entry.prefixLength, stableLength), sessionId))
        : entry.messages
  } else {
    // First read, rewrite, or truncation: full re-parse of the stable prefix.
    prefixMessages = parseJsonl(raw.slice(0, stableLength), sessionId)
  }

  if (!entry || entry.prefixLength !== stableLength || entry.messages !== prefixMessages) {
    remember(filePath, {
      prefixLength: stableLength,
      prefixHash: hashPrefix(raw, stableLength),
      messages: prefixMessages,
    })
  }

  const tail = raw.slice(stableLength)
  const all = tail.trim().length > 0 ? prefixMessages.concat(parseJsonl(tail, sessionId)) : prefixMessages
  return sortByTimestamp(all)
}

/**
 * Sort messages by their `timestamp` ASC (oldest first → newest last).
 *
 * Claude Code's JSONL is a DAG (records carry `parentUuid` for branching
 * resumes), so file-order is NOT strictly chronological — a resumed
 * session can interleave records from different branches. The chat pane
 * relies on `past[]` being chronological so newest messages render at
 * the bottom; we sort here at the engine boundary so every consumer
 * gets the same shape.
 *
 * Stable sort: ties (same ISO timestamp) keep file-order, which roughly
 * preserves causal ordering even at sub-millisecond ties.
 */
function sortByTimestamp(messages: Message[]): Message[] {
  return messages
    .map((msg, idx) => ({ msg, idx }))
    .sort((a, b) => {
      if (a.msg.timestamp < b.msg.timestamp) return -1
      if (a.msg.timestamp > b.msg.timestamp) return 1
      return a.idx - b.idx
    })
    .map((entry) => entry.msg)
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
