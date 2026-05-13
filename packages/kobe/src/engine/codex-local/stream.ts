/**
 * Line-delimited JSON parser for `codex exec --json`.
 *
 * Codex's stream-json shape (observed in CLI v0.130):
 *
 *   { type: "session_meta", payload: { id: "<UUID>" } }
 *   { type: "thread.started", thread_id: "<UUID>" }
 *       — emitted once at the start of a session, depending on Codex
 *         CLI version. We prefer `session_meta.payload.id` because it is
 *         the persisted rollout id used by `codex exec resume` and by
 *         the Codex rollout JSONL filename lookup; `thread_id` is
 *         accepted as a legacy stream fallback. No EngineEvent emitted.
 *
 *   { type: "turn.started" }
 *       — informational; no EngineEvent.
 *
 *   { type: "item.started", item: { id, type, ...payload } }
 *   { type: "item.completed", item: { id, type, ...payload } }
 *       — item.type === "agent_message"      → assistant.delta (whole
 *         message text in `.text`; codex doesn't stream deltas)
 *       — item.type === "command_execution"  → tool.start (on .started)
 *                                              tool.result (on .completed)
 *       — other item types (reasoning, file_edit, …) → for now treated
 *         the same way as command_execution: a tool.start / tool.result
 *         pair so the chat surface lights up. The renderer's tool
 *         strategy registry can specialise later.
 *
 *   { type: "turn.completed", usage: { input_tokens, cached_input_tokens,
 *                                       output_tokens, reasoning_output_tokens } }
 *       — emit `usage`, then `done` and stop consuming. Codex's
 *         `input_tokens` already includes `cached_input_tokens` and
 *         `reasoning_output_tokens` is hidden model compute, so both are
 *         normalized before reaching kobe's Claude-shaped usage snapshot.
 *
 * Bad lines collapse to an `error` event; the iterator continues.
 */

import type { EngineEvent } from "@/types/engine"
import { codexUsageToSnapshot } from "./usage"

export type LineSource = AsyncIterable<string>

export interface ParseStreamJsonOpts {
  /**
   * Called exactly once when we observe Codex's persisted session id.
   * CodexLocal uses this to resolve the deferred returned from `spawn()`.
   */
  readonly onSessionId?: (sessionId: string) => void
  /**
   * Best-effort context-window fallback. The exec JSON stream drops
   * Codex app-server's `modelContextWindow`, so CodexLocal may fill it
   * from OpenRouter model metadata.
   */
  readonly contextWindowTokens?: () => Promise<number | undefined>
}

export async function* parseStreamJson(lines: LineSource, opts: ParseStreamJsonOpts = {}): AsyncIterable<EngineEvent> {
  let sessionIdEmitted = false
  const toolNameById = new Map<string, string>()
  const startedByItemId = new Set<string>()

  for await (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch (err) {
      yield { type: "error", message: `codex stream-json parse failed: ${stringifyErr(err)}` }
      continue
    }

    if (!isObject(msg)) continue
    const type = typeof msg.type === "string" ? (msg.type as string) : undefined
    if (!type) continue

    if (type === "session_meta" || type === "thread.started") {
      const sid = codexSessionId(msg)
      if (sid && !sessionIdEmitted) {
        sessionIdEmitted = true
        opts.onSessionId?.(sid)
      }
      continue
    }

    if (type === "turn.started") continue

    if (type === "item.started" || type === "item.completed") {
      const item = isObject(msg.item) ? (msg.item as Record<string, unknown>) : undefined
      if (!item) continue
      const itemId = typeof item.id === "string" ? (item.id as string) : undefined
      const itemType = typeof item.type === "string" ? (item.type as string) : "tool"

      if (itemType === "agent_message") {
        // Whole-message: emit once on item.completed (only contains text
        // at that point). Skip on item.started — codex starts items
        // for agent_message with an empty/incomplete shape.
        if (type !== "item.completed") continue
        const text = typeof item.text === "string" ? (item.text as string) : ""
        if (text) yield { type: "assistant.delta", text }
        continue
      }

      if (isReasoningItem(itemType)) {
        const text = reasoningTextFromItem(item)
        if (text.length > 0) yield { type: "reasoning.delta", text }
        continue
      }

      // Anything else maps to a tool banner pair. The renderer's
      // tool-name strategy registry decides how to render each name.
      if (itemId) {
        toolNameById.set(itemId, itemType)
      }

      if (type === "item.started") {
        if (itemId) startedByItemId.add(itemId)
        const input = stripIdAndType(item)
        yield { type: "tool.start", name: itemType, input }
        continue
      }

      // item.completed for non-message items.
      // If we never saw the matching started (codex skips it for some
      // fast items), synthesize a tool.start first so the renderer
      // doesn't see an orphan tool.result with no banner.
      if (itemId && !startedByItemId.has(itemId)) {
        const input = stripIdAndType(item)
        yield { type: "tool.start", name: itemType, input }
      }
      if (itemId) startedByItemId.delete(itemId)
      const output = stripIdAndType(item)
      yield { type: "tool.result", name: itemType, output }
      continue
    }

    if (type === "turn.completed") {
      const usage = isObject(msg.usage) ? (msg.usage as Record<string, unknown>) : undefined
      if (usage) {
        const contextWindowTokens = await opts.contextWindowTokens?.()
        const snapshot = codexUsageToSnapshot(usage, { contextWindowTokens })
        if (snapshot) yield { type: "usage", ...snapshot }
      }
      yield { type: "done" }
      return
    }

    if (type === "error") {
      const message = typeof msg.message === "string" ? (msg.message as string) : "codex emitted an error"
      yield { type: "error", message }
      return
    }
  }
}

export async function* readLines(stream: AsyncIterable<unknown>): AsyncIterable<string> {
  let buf = ""
  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
    buf += text
    let nl = buf.indexOf("\n")
    while (nl !== -1) {
      yield buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      nl = buf.indexOf("\n")
    }
  }
  if (buf.length > 0) yield buf
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function codexSessionId(msg: Record<string, unknown>): string | undefined {
  if (msg.type === "session_meta") {
    const payload = isObject(msg.payload) ? (msg.payload as Record<string, unknown>) : undefined
    const id = payload?.id
    return typeof id === "string" && id.length > 0 ? id : undefined
  }
  const id = msg.thread_id
  return typeof id === "string" && id.length > 0 ? id : undefined
}

function isReasoningItem(itemType: string): boolean {
  return itemType.toLowerCase().includes("reason")
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

/** Strip the housekeeping fields so the tool input/output payload is the meaningful slice. */
function stripIdAndType(item: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, type: _type, ...rest } = item
  return rest
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
