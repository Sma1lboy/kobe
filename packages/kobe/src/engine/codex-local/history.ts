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
 * We extract `response_item` records of type `message` with a known role
 * and surface them via {@link Message}; other record types are dropped.
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
import type { EngineHistory, EngineUsageSnapshot, Message } from "@/types/engine"
import { normalizeCodexContent } from "./normalize"
import { isSyntheticCodexUserRow } from "./synthetic"

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
    const ts = typeof parsed.timestamp === "string" ? (parsed.timestamp as string) : new Date().toISOString()
    out.push({ role, blocks, timestamp: ts, sessionId })
  }
  return out
}

export function deriveCodexUsageMetrics(raw: string): EngineUsageSnapshot | undefined {
  let latestUsage: EngineUsageSnapshot | undefined
  let latestUsageTimestampMs: number | null = null
  let lastUserTimestampMs: number | null = null
  let inputTokens = 0
  let outputTokens = 0
  const intervals: Array<{ startMs: number; endMs: number }> = []

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
    if (parsed.type === "response_item") {
      const payload = isObject(parsed.payload) ? (parsed.payload as Record<string, unknown>) : undefined
      if (payload?.type === "message" && payload.role === "user" && timestampMs !== null) {
        const blocks = normalizeCodexContent(payload.content)
        if (!isSyntheticCodexUserRow(blocks)) lastUserTimestampMs = timestampMs
      }
      continue
    }

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

    inputTokens += snapshot.input_tokens
    outputTokens += snapshot.output_tokens
    if (timestampMs !== null && lastUserTimestampMs !== null && timestampMs > lastUserTimestampMs) {
      intervals.push({ startMs: lastUserTimestampMs, endMs: timestampMs })
    }
  }

  if (!latestUsage) return undefined
  const durationMs = mergedDurationMs(intervals)
  if (durationMs <= 0) return latestUsage
  return {
    ...latestUsage,
    total_speed_tokens_per_second: (inputTokens + outputTokens) / (durationMs / 1000),
  }
}

function codexUsageToSnapshot(usage: Record<string, unknown>): EngineUsageSnapshot | undefined {
  const input = numberOr(usage.input_tokens, 0)
  const output = numberOr(usage.output_tokens, 0) + numberOr(usage.reasoning_output_tokens, 0)
  const cacheRead = typeof usage.cached_input_tokens === "number" ? usage.cached_input_tokens : undefined
  if (input <= 0 && output <= 0 && cacheRead === undefined) return undefined
  return {
    input_tokens: input,
    output_tokens: output,
    ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
  }
}

function parseTimestampMs(value: string): number | null {
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

function mergedDurationMs(intervals: readonly { startMs: number; endMs: number }[]): number {
  if (intervals.length === 0) return 0
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs)
  let total = 0
  let current = sorted[0]
  if (!current) return 0
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]
    if (!next) continue
    if (next.startMs <= current.endMs) {
      current = { startMs: current.startMs, endMs: Math.max(current.endMs, next.endMs) }
    } else {
      total += current.endMs - current.startMs
      current = next
    }
  }
  total += current.endMs - current.startMs
  return total
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
