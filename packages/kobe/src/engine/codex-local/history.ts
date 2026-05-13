/**
 * Read historical messages from Codex's on-disk rollout JSONL.
 *
 * Where Codex keeps sessions:
 *
 *     ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO-TS>-<UUID>.jsonl
 *
 * Each line has shape:
 *
 *     { "type": "session_meta", "payload": { "id": "<UUID>", "cwd": "...", ... } }
 *     { "type": "response_item", "payload": { "type": "message", "role": "user"|"assistant",
 *                                              "content": [{ "type": "input_text"|"output_text", ... }] } }
 *     { "type": "event_msg", ... }
 *     { "type": "turn_context", ... }
 *     (more)
 *
 * We extract `response_item` records of type `message` with a known role,
 * plus persisted Codex tool call/result items, and surface them via
 * {@link Message}; other record types are dropped.
 *
 * Session-lookup-by-UUID requires scanning the date-organized tree
 * because the UUID alone doesn't carry the rollout date — newest-first
 * to bias toward recent sessions. ENOENT / unreadable files are
 * tolerated per-entry so a single corrupt rollout doesn't blank the
 * whole result.
 */

import { readFile, readdir, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { ContentBlock } from "@/types/content"
import type { EngineHistory, EngineUsageSnapshot, Message } from "@/types/engine"
import { normalizeCodexContent } from "./normalize"
import { isSyntheticCodexUserRow } from "./synthetic"
import { codexUsageToSnapshot } from "./usage"

export interface HistoryDeps {
  /** Absolute path to `~/.codex/sessions`. */
  sessionsDir(): string
  readdir(p: string): Promise<string[]>
  readFile(p: string): Promise<string>
}

const defaultDeps: HistoryDeps = {
  sessionsDir() {
    return path.join(homedir(), ".codex", "sessions")
  },
  async readdir(p) {
    try {
      return await readdir(p)
    } catch {
      return []
    }
  },
  async readFile(p) {
    return await readFile(p, "utf8")
  },
}

/**
 * Scan the date tree, newest first. Returns absolute paths to rollout
 * files in approximate newest→oldest order. Best-effort: missing /
 * unreadable dirs are skipped silently.
 */
export async function listRolloutFiles(deps: HistoryDeps = defaultDeps): Promise<string[]> {
  const root = deps.sessionsDir()
  const years = (await deps.readdir(root)).sort().reverse()
  const out: string[] = []
  for (const y of years) {
    const yp = path.join(root, y)
    const months = (await deps.readdir(yp)).sort().reverse()
    for (const m of months) {
      const mp = path.join(yp, m)
      const days = (await deps.readdir(mp)).sort().reverse()
      for (const d of days) {
        const dp = path.join(mp, d)
        const files = (await deps.readdir(dp)).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))
        // Files within a day: lexicographic == chronological (filename
        // begins with the ISO timestamp), so reversed = newest first.
        files.sort().reverse()
        for (const f of files) out.push(path.join(dp, f))
      }
    }
  }
  return out
}

/**
 * Find the rollout file whose UUID matches `sessionId`. Returns the
 * absolute path or `undefined` if no match. We scan newest-first so
 * recent sessions resolve in a couple of stat calls.
 */
export async function findRolloutFile(sessionId: string, deps: HistoryDeps = defaultDeps): Promise<string | undefined> {
  const all = await listRolloutFiles(deps)
  for (const p of all) {
    if (path.basename(p).endsWith(`-${sessionId}.jsonl`)) return p
  }
  return undefined
}

export async function readHistory(sessionId: string, deps: HistoryDeps = defaultDeps): Promise<Message[]> {
  return (await readHistoryWithMetrics(sessionId, deps)).messages as Message[]
}

export async function readHistoryWithMetrics(
  sessionId: string,
  deps: HistoryDeps = defaultDeps,
): Promise<EngineHistory> {
  const file = await findRolloutFile(sessionId, deps)
  if (!file) return { messages: [] }
  let raw: string
  try {
    raw = await deps.readFile(file)
  } catch {
    return { messages: [] }
  }
  const messages = sortByTimestamp(parseJsonl(raw, sessionId))
  const usageMetrics = deriveCodexUsageMetrics(raw)
  return { messages, ...(usageMetrics ? { usageMetrics } : {}) }
}

export async function deleteHistory(sessionId: string, deps: HistoryDeps = defaultDeps): Promise<void> {
  const file = await findRolloutFile(sessionId, deps)
  if (!file) return
  try {
    await unlink(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    throw err
  }
}

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

export function parseJsonl(raw: string, sessionId: string): Message[] {
  const out: Message[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isObject(parsed)) continue
    if (parsed.type !== "response_item") continue
    const payload = isObject(parsed.payload) ? (parsed.payload as Record<string, unknown>) : undefined
    if (!payload) continue
    const ts = typeof parsed.timestamp === "string" ? (parsed.timestamp as string) : new Date().toISOString()
    if (payload.type === "function_call") {
      const msg = normalizeCodexToolCall(payload, ts, sessionId)
      if (msg) out.push(msg)
      continue
    }
    if (payload.type === "function_call_output") {
      const msg = normalizeCodexToolResult(payload, ts, sessionId)
      if (msg) out.push(msg)
      continue
    }
    if (payload.type !== "message") continue
    const role = payload.role
    if (role !== "user" && role !== "assistant" && role !== "system") continue
    const blocks = normalizeCodexContent(payload.content)
    // Drop Codex's synthetic user rows. Codex persists both repository
    // instructions and the environment envelope in rollout JSONL as
    // role=user messages, but the live `codex exec --json` stream does
    // not replay them. Reloading history should therefore hide them so
    // the visible transcript matches what the user actually typed.
    if (role === "user" && isSyntheticCodexUserRow(blocks)) continue
    out.push({ role, blocks, timestamp: ts, sessionId })
  }
  return out
}

function normalizeCodexToolCall(
  payload: Record<string, unknown>,
  timestamp: string,
  sessionId: string,
): Message | undefined {
  const callId = typeof payload.call_id === "string" ? payload.call_id : undefined
  if (!callId) return undefined
  const name = typeof payload.name === "string" && payload.name.length > 0 ? payload.name : "function_call"
  const block: ContentBlock = {
    type: "tool_call",
    callId,
    name,
    input: parseMaybeJson(payload.arguments),
  }
  return { role: "assistant", blocks: [block], timestamp, sessionId }
}

function normalizeCodexToolResult(
  payload: Record<string, unknown>,
  timestamp: string,
  sessionId: string,
): Message | undefined {
  const callId = typeof payload.call_id === "string" ? payload.call_id : undefined
  if (!callId) return undefined
  const block: ContentBlock = {
    type: "tool_result",
    callId,
    output: parseMaybeJson(payload.output),
    isError: false,
  }
  return { role: "user", blocks: [block], timestamp, sessionId }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function deriveCodexUsageMetrics(raw: string): EngineUsageSnapshot | undefined {
  let latestUsage: EngineUsageSnapshot | undefined
  let latestUsageTimestampMs: number | null = null

  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isObject(parsed)) continue

    const timestampMs = typeof parsed.timestamp === "string" ? parseTimestampMs(parsed.timestamp) : null
    if (parsed.type === "response_item") continue

    if (parsed.type !== "turn.completed") continue
    const usage = isObject(parsed.usage) ? (parsed.usage as Record<string, unknown>) : undefined
    if (!usage) continue
    const snapshot = codexUsageToSnapshot(usage)
    if (!snapshot) continue

    if (timestampMs !== null && (latestUsageTimestampMs === null || timestampMs > latestUsageTimestampMs)) {
      latestUsageTimestampMs = timestampMs
      latestUsage = snapshot
    } else if (latestUsage === undefined) {
      latestUsage = snapshot
    }
  }

  return latestUsage
}

function parseTimestampMs(value: string): number | null {
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
