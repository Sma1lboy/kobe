/**
 * Claude Code's {@link EngineTurnReader} — per-turn telemetry lifted out of
 * its own JSONL transcript (issue #32).
 *
 * The turn boundary Claude persists: a `user` record with real prompt content
 * opens a turn, every `assistant` record after it belongs to that turn, and
 * the turn closes at the next such `user` record. Tool-result `user` records
 * do NOT open a turn — they are the engine talking to itself mid-turn, so
 * they're skipped (same predicate the history parser already uses to keep
 * them out of the title path).
 *
 * Usage is summed per assistant MESSAGE id, not per record: Claude writes one
 * record per content block (thinking, tool_use, …) and repeats the SAME
 * `message.usage` on each — naively summing records multiplies a turn's cost
 * by its block count. `model` is the last one seen (a turn that switches
 * models mid-flight is attributed to what finished it).
 *
 * Pure (string in, records out) so it unit-tests without a filesystem; the
 * bounded file read lives in the reader wrapper below.
 */

import type { AgentTurn } from "../agent-turn.ts"
import { isJsonlLineWithinBound, readTextFileBounded } from "../file-bounds.ts"
import { isSyntheticClaudeRecord } from "./synthetic.ts"

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** True when a `user` record is the human opening a turn — i.e. its content
 *  is not purely `tool_result` blocks (the engine feeding itself). A plain
 *  string content is always a human prompt. */
function opensTurn(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some((b) => !isObject(b) || b.type !== "tool_result")
}

interface Usage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

interface Draft {
  id: string
  sessionId: string
  model?: string
  startedAt: number
  endedAt: number
  /** Per assistant `message.id` — Claude repeats one usage across a message's records. */
  usageByMessage: Map<string, Usage>
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

function readUsage(v: unknown): Usage | undefined {
  if (!isObject(v)) return undefined
  return {
    input_tokens: num(v.input_tokens),
    output_tokens: num(v.output_tokens),
    cache_read_input_tokens: num(v.cache_read_input_tokens),
    cache_creation_input_tokens: num(v.cache_creation_input_tokens),
  }
}

function finish(draft: Draft): AgentTurn | null {
  // A turn with no assistant reply (interrupted before the model answered)
  // has no id and nothing to attribute — drop it rather than emit a stub.
  if (!draft.id) return null
  const totals: Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
  for (const u of draft.usageByMessage.values()) {
    totals.input_tokens += u.input_tokens
    totals.output_tokens += u.output_tokens
    totals.cache_read_input_tokens += u.cache_read_input_tokens
    totals.cache_creation_input_tokens += u.cache_creation_input_tokens
  }
  return {
    id: draft.id,
    sessionId: draft.sessionId,
    ...(draft.model ? { model: draft.model } : {}),
    startedAt: draft.startedAt,
    endedAt: draft.endedAt,
    ...(draft.usageByMessage.size > 0 ? { usage: totals } : {}),
  }
}

/**
 * Parse a Claude JSONL transcript into completed turns, oldest-first.
 * `fallbackSessionId` names the session when a record omits `sessionId`.
 * Exported for unit tests; production callers use {@link readClaudeTurns}.
 */
export function parseClaudeTurns(raw: string, fallbackSessionId = ""): AgentTurn[] {
  const out: AgentTurn[] = []
  let draft: Draft | null = null

  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || !isJsonlLineWithinBound(trimmed)) continue
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isObject(record) || isSyntheticClaudeRecord(record)) continue

    const inner = isObject(record.message) ? record.message : record
    const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
    if (!Number.isFinite(at)) continue
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : fallbackSessionId

    if (inner.role === "user") {
      if (!opensTurn(inner.content)) continue
      if (draft) {
        const done = finish(draft)
        if (done) out.push(done)
      }
      draft = { id: "", sessionId, startedAt: at, endedAt: at, usageByMessage: new Map() }
      continue
    }
    if (inner.role !== "assistant" || !draft) continue

    draft.endedAt = at
    if (typeof inner.model === "string") draft.model = inner.model
    const messageId = typeof inner.id === "string" ? inner.id : ""
    // The turn's id is its LAST assistant message — stable across re-reads of
    // a finished turn, and never colliding with the next turn's.
    if (messageId) draft.id = messageId
    const usage = readUsage(inner.usage)
    if (usage && messageId) draft.usageByMessage.set(messageId, usage)
  }

  // The trailing draft IS a completed turn once the engine stopped — the hook
  // that triggers this read fires on Stop, so the last assistant record it
  // sees closed the turn. (A turn still running just re-reads next time and
  // dedupes on the same message id.)
  if (draft) {
    const done = finish(draft)
    if (done) out.push(done)
  }
  return out
}

/** Claude's {@link import("../agent-turn.ts").EngineTurnReader}: bounded file
 *  read + {@link parseClaudeTurns}. Never throws — an unreadable transcript
 *  yields no turns. */
export async function readClaudeTurns(transcriptPath: string): Promise<readonly AgentTurn[]> {
  try {
    const raw = await readTextFileBounded(transcriptPath)
    return parseClaudeTurns(raw)
  } catch {
    return []
  }
}
