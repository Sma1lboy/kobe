/**
 * Line-delimited JSON parser for `claude --output-format stream-json`.
 *
 * Maps Claude Code's native event shapes onto kobe's normalized
 * {@link EngineEvent} discriminated union. This is the *only* place in
 * the codebase that knows the raw stream-json schema — by contract
 * (DESIGN.md §5.2 / §6.1), the orchestrator must never see a raw
 * stream-json event.
 *
 * --- Stream-json shape (cross-checked against opcode's parser at
 *     refs/opcode/src-tauri/src/commands/claude.rs lines 1232–1265 and
 *     refs/opcode/src/components/AgentExecution.tsx lines 61–76) ---
 *
 *   { type: "system", subtype: "init", session_id: "<uuid>", ... }
 *       — emitted once at session start. We capture session_id and
 *         resolve {@link captureSessionId}'s deferred. We do NOT emit
 *         an EngineEvent for this — the session id is delivered out of
 *         band via `ClaudeCodeLocal.spawn()`'s return value.
 *
 *   { type: "assistant", message: { content: [
 *       { type: "text", text: "..." },
 *       { type: "tool_use", id, name, input },
 *     ] } }
 *       — text blocks → `assistant.delta`. tool_use blocks → `tool.start`.
 *
 *   { type: "user", message: { content: [
 *       { type: "tool_result", tool_use_id, content },
 *     ] } }
 *       — tool_result blocks → `tool.result`. The Claude CLI replays
 *         tool results as user messages; we surface them as `tool.result`
 *         to keep the orchestrator's UI logic clean.
 *
 *   { type: "result", subtype: "success" | "error_max_turns" | ...,
 *     usage: { input_tokens, output_tokens }, total_cost_usd, ... }
 *       — emit `usage` (if usage present), then `done`. If subtype
 *         signals failure we instead emit `error` with the subtype.
 *
 * Anything not matching the above is dropped silently. Bad JSON lines
 * are surfaced as a one-shot `error` event and the iterator continues
 * (the human-readable stderr is captured separately by ClaudeCodeLocal).
 *
 * Tool-name resolution for tool.result: the raw event only has
 * `tool_use_id`, not the tool name. We thread a small in-iterator map
 * from id → name populated on each tool_use block, so consumers see
 * `{ type: "tool.result", name: "Read", output: ... }` without needing
 * cross-event correlation themselves.
 */

import type { EngineEvent } from "@/types/engine"

/** Async source of newline-delimited input (typically a child's stdout). */
export type LineSource = AsyncIterable<string>

/** Input strings: either an `AsyncIterable<string>` of complete lines or a `Readable` buffer stream. */
export interface ParseStreamJsonOpts {
  /**
   * Called exactly once when we observe a `system.init` message and
   * extract a session_id. ClaudeCodeLocal uses this to resolve the
   * deferred returned from `spawn()`. Subsequent inits (claude
   * shouldn't emit them, but be defensive) are ignored.
   */
  readonly onSessionId?: (sessionId: string) => void
}

/**
 * Parse a stream of stdout lines into a sequence of {@link EngineEvent}.
 *
 * The returned iterator terminates when the source iterator does. The
 * caller is responsible for terminating the source (closing stdout,
 * killing the child, etc.).
 *
 * The caller is also responsible for guaranteeing line boundaries —
 * see {@link readLines} for a readable-stream-to-lines adapter.
 */
export async function* parseStreamJson(lines: LineSource, opts: ParseStreamJsonOpts = {}): AsyncIterable<EngineEvent> {
  let sessionIdEmitted = false
  // tool_use_id → tool name, used to enrich tool.result events.
  const toolNameById = new Map<string, string>()

  for await (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch (err) {
      yield { type: "error", message: `stream-json parse failed: ${stringifyErr(err)}` }
      continue
    }

    if (!isObject(msg)) continue
    const type = typeof msg.type === "string" ? (msg.type as string) : undefined
    if (!type) continue

    if (type === "system") {
      const subtype = typeof msg.subtype === "string" ? (msg.subtype as string) : undefined
      if (subtype === "init" && !sessionIdEmitted) {
        const sid = typeof msg.session_id === "string" ? (msg.session_id as string) : undefined
        if (sid) {
          sessionIdEmitted = true
          opts.onSessionId?.(sid)
        }
      }
      // system.init / other system events do not produce EngineEvents.
      continue
    }

    if (type === "assistant") {
      const content = extractContentBlocks(msg)
      for (const block of content) {
        if (!isObject(block)) continue
        const blockType = typeof block.type === "string" ? (block.type as string) : undefined
        if (blockType === "text") {
          const text = typeof block.text === "string" ? (block.text as string) : ""
          if (text) yield { type: "assistant.delta", text }
        } else if (blockType === "tool_use") {
          const name = typeof block.name === "string" ? (block.name as string) : "tool"
          const id = typeof block.id === "string" ? (block.id as string) : undefined
          if (id) toolNameById.set(id, name)
          const input = "input" in block ? block.input : undefined
          yield { type: "tool.start", name, input }
        }
      }
      continue
    }

    if (type === "user") {
      const content = extractContentBlocks(msg)
      for (const block of content) {
        if (!isObject(block)) continue
        const blockType = typeof block.type === "string" ? (block.type as string) : undefined
        if (blockType === "tool_result") {
          const id = typeof block.tool_use_id === "string" ? (block.tool_use_id as string) : undefined
          const name = (id && toolNameById.get(id)) || "tool"
          const output = "content" in block ? block.content : undefined
          yield { type: "tool.result", name, output }
        }
      }
      continue
    }

    if (type === "result") {
      const usage = isObject(msg.usage) ? (msg.usage as Record<string, unknown>) : undefined
      if (usage) {
        const inTok = typeof usage.input_tokens === "number" ? (usage.input_tokens as number) : 0
        const outTok = typeof usage.output_tokens === "number" ? (usage.output_tokens as number) : 0
        yield { type: "usage", input_tokens: inTok, output_tokens: outTok }
      }
      const subtype = typeof msg.subtype === "string" ? (msg.subtype as string) : "success"
      if (subtype === "success") {
        yield { type: "done" }
      } else {
        yield { type: "error", message: `claude session ended: ${subtype}` }
      }
      // Whether success or error, this is the terminal event — stop
      // consuming (the source may keep producing keepalives). We rely
      // on the caller closing the source; we just return.
      return
    }

    // Unknown shape: drop. Future-compatible — claude may add new top-
    // level types and we don't want to crash a session for it.
  }
}

/**
 * Convert a Node `Readable` (or any stream that emits `data` chunks of
 * Buffer/string) into an async iterable of complete UTF-8 lines.
 *
 * Bun and Node both support `for await` over Readables, but they yield
 * arbitrary chunks, not lines. This helper buffers and splits on `\n`.
 */
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
  // Trailing partial line (no newline) — emit if non-empty so callers
  // see a final event when claude exits without a trailing newline.
  if (buf.length > 0) yield buf
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function extractContentBlocks(msg: Record<string, unknown>): unknown[] {
  // Two shapes appear in the wild — bare `{content: [...]}` and
  // `{message: {content: [...]}}`. We accept both.
  if (Array.isArray(msg.content)) return msg.content as unknown[]
  const inner = msg.message
  if (isObject(inner) && Array.isArray(inner.content)) return inner.content as unknown[]
  return []
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
