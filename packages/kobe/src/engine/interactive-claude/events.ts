/**
 * Map a Claude Code transcript JSONL record onto kobe's normalized
 * {@link EngineEvent} union.
 *
 * Part of KOB-208. This is the disk-record analogue of
 * `claude-code-local/stream.ts` (which maps the live `stream-json`
 * protocol). The shapes overlap heavily — both carry
 * `{ type: "assistant"|"user", message: { content: [...] } }` — but a
 * transcript has no terminal `result` record, so turn completion is
 * decided by the caller from {@link MappedRecord.stopReason}.
 *
 * What is deliberately NOT surfaced:
 *   - the user's own prompt text — kobe echoes that from the composer,
 *     exactly as the `claude -p` path does; only `tool_result` blocks
 *     on `user` records become events.
 *   - subagent / sidechain records (`isSidechain: true`) — nested
 *     subagent rendering for the interactive path is out of scope.
 */

import type { EngineEvent } from "@/types/engine"

export interface MappedRecord {
  /** Engine events derived from this record, in block order. */
  readonly events: readonly EngineEvent[]
  /** `message.role`, when present. */
  readonly role?: "user" | "assistant" | "system"
  /** `message.stop_reason`, when present — the caller uses it to decide turn completion. */
  readonly stopReason?: string
}

const EMPTY: MappedRecord = { events: [] }

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function contentBlocks(inner: Record<string, unknown>): unknown[] {
  if (Array.isArray(inner.content)) return inner.content
  return []
}

/**
 * Convert one transcript record into events. Returns {@link EMPTY} for
 * records that carry no renderable conversation (system metadata,
 * summaries, file-history snapshots, subagent sidechains).
 */
export function recordToEvents(record: Record<string, unknown>): MappedRecord {
  // Subagent internal records are tagged `isSidechain: true`. Surfacing
  // them would flatten a subagent's private transcript into the main
  // conversation — drop them (nested rendering is a separate concern).
  if (record.isSidechain === true) return EMPTY

  const inner = isObject(record.message) ? record.message : record
  const role = inner.role
  if (role !== "user" && role !== "assistant" && role !== "system") return EMPTY

  const events: EngineEvent[] = []

  if (role === "assistant") {
    for (const block of contentBlocks(inner)) {
      if (!isObject(block)) continue
      const blockType = typeof block.type === "string" ? block.type : undefined
      if (blockType === "text" && typeof block.text === "string" && block.text.length > 0) {
        events.push({ type: "assistant.delta", text: block.text })
      } else if (blockType === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) {
        events.push({ type: "reasoning.delta", text: block.thinking })
      } else if (blockType === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "tool"
        const id = typeof block.id === "string" ? block.id : undefined
        events.push({
          type: "tool.start",
          name,
          input: "input" in block ? block.input : undefined,
          ...(id ? { id } : {}),
        })
      }
    }
    const usage = isObject(inner.usage) ? inner.usage : undefined
    if (usage) {
      const inTok = typeof usage.input_tokens === "number" ? usage.input_tokens : 0
      const outTok = typeof usage.output_tokens === "number" ? usage.output_tokens : 0
      const cacheRead = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined
      const cacheCreate =
        typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : undefined
      events.push({
        type: "usage",
        input_tokens: inTok,
        output_tokens: outTok,
        ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
        ...(cacheCreate !== undefined ? { cache_creation_input_tokens: cacheCreate } : {}),
      })
    }
    const stopReason = typeof inner.stop_reason === "string" ? inner.stop_reason : undefined
    return stopReason ? { events, role, stopReason } : { events, role }
  }

  if (role === "user") {
    for (const block of contentBlocks(inner)) {
      if (!isObject(block)) continue
      if (block.type === "tool_result") {
        const name = "tool" // transcript tool_result carries no name; the chat tolerates this
        events.push({
          type: "tool.result",
          name,
          output: "content" in block ? block.content : undefined,
        })
      }
    }
    return { events, role }
  }

  return { events: [], role }
}
