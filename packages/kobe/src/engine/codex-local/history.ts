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

import { readFile, readdir, stat, unlink } from "node:fs/promises"
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
  /** mtime probe — injected so the activity poll is unit-testable. */
  stat(p: string): Promise<{ mtimeMs: number }>
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
  stat,
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
  if (!sessionId) return undefined
  const want = sessionId.toLowerCase()
  const all = await listRolloutFiles(deps)
  for (const p of all) {
    // Match the FULL embedded UUID, not an `endsWith(`-${sessionId}`)` suffix:
    // a partial/truncated id can align to an internal UUID `-` boundary and
    // resolve an unrelated session's transcript.
    if (path.basename(p).match(UUID_AT_END)?.[1]?.toLowerCase() === want) return p
  }
  return undefined
}

/** UUID embedded at the tail of a `rollout-<ISO>-<UUID>.jsonl` filename. */
const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/** The `cwd` recorded on a rollout's `session_meta` line, or `""`. */
export function rolloutCwd(raw: string): string {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed) as { type?: string; payload?: { cwd?: string } }
      if (rec.type === "session_meta") return rec.payload?.cwd ?? ""
    } catch {
      // tolerate a malformed leading line
    }
    // session_meta is the first record; if the first JSON line isn't it,
    // this rollout has no meta — stop probing.
    return ""
  }
  return ""
}

/**
 * `session_meta.cwd` memo, keyed by rollout path. A rollout's
 * `session_meta` is its FIRST line, written once at session start, and
 * rollout filenames embed a UUID + ISO timestamp so a path is never
 * reused — a successfully parsed, non-empty cwd is immutable and can be
 * cached forever. The polling callers (the Ops pane's 2.5s activity poll
 * and 1.5s turn poll, the daemon's 4s auto-title tick) previously
 * re-READ up to 12–200 whole rollout JSONLs per tick just to re-derive
 * the same first-line cwd.
 *
 * Two deliberate non-caches:
 *   - `""` (no/invalid session_meta) is NOT cached: a rollout caught
 *     mid-write can briefly have a partial first line, and pinning `""`
 *     would permanently hide that session from the pollers.
 *   - a failed read is NOT cached (the file may appear/become readable).
 *
 * Keyed per `HistoryDeps` object (WeakMap) so injected test deps never
 * share state with production or with each other.
 */
const rolloutCwdCaches = new WeakMap<HistoryDeps, Map<string, string>>()

/** Cached cwd for one rollout file: `""` = no meta, `null` = unreadable. */
async function rolloutCwdForFile(file: string, deps: HistoryDeps): Promise<string | null> {
  let cache = rolloutCwdCaches.get(deps)
  if (!cache) {
    cache = new Map()
    rolloutCwdCaches.set(deps, cache)
  }
  const hit = cache.get(file)
  if (hit !== undefined) return hit
  let raw: string
  try {
    raw = await deps.readFile(file)
  } catch {
    return null
  }
  const cwd = rolloutCwd(raw)
  if (cwd) cache.set(file, cwd)
  return cwd
}

/** Cap on rollout files probed by {@link listSessionIdsForWorktree}. */
const MAX_WORKTREE_SCAN = 200

/**
 * Session UUIDs whose rollout `session_meta.cwd` equals `worktree`,
 * oldest-first. The Codex analogue of claude-code's
 * `listSessionFilesForWorktree` — Codex stores rollouts in a global
 * date tree (not per-worktree dirs), so we scan newest-first (capped)
 * and filter by the recorded cwd, then reverse to oldest-first so the
 * caller sees the worktree's origin conversation first. cwd probes hit
 * the {@link rolloutCwdForFile} memo, so a repeat scan (the auto-title
 * poller's tick) reads no rollout it has seen before.
 */
export async function listSessionIdsForWorktree(worktree: string, deps: HistoryDeps = defaultDeps): Promise<string[]> {
  if (!worktree) return []
  const files = await listRolloutFiles(deps)
  const matches: string[] = []
  let scanned = 0
  for (const file of files) {
    if (scanned >= MAX_WORKTREE_SCAN) break
    scanned++
    if ((await rolloutCwdForFile(file, deps)) !== worktree) continue
    const id = path.basename(file).match(UUID_AT_END)?.[1]
    if (id) matches.push(id)
  }
  return matches.reverse()
}

/** Reads probed before giving up the cwd-match scan in {@link findLatestRolloutForWorktree}. */
const MAX_MTIME_SCAN = 12

/**
 * The newest rollout recorded for `worktree` (path + current mtime), or
 * `null` when none match. Walks `listRolloutFiles` (newest-first by
 * filename ≈ chronological) and returns the first cwd match — the file
 * the agent just appended to is the newest, so the common case is a
 * single probe, and with the {@link rolloutCwdForFile} memo a REPEAT
 * poll issues no file reads at all (directory listings + one stat).
 * Capped at {@link MAX_MTIME_SCAN} probes so a busy machine with many
 * unrelated sessions can't make the poll expensive. A match whose stat
 * fails (deleted mid-scan) is skipped and the scan continues.
 */
export async function findLatestRolloutForWorktree(
  worktree: string,
  deps: HistoryDeps = defaultDeps,
): Promise<{ path: string; mtimeMs: number } | null> {
  if (!worktree) return null
  const files = await listRolloutFiles(deps)
  let scanned = 0
  for (const file of files) {
    if (scanned >= MAX_MTIME_SCAN) break
    scanned++
    if ((await rolloutCwdForFile(file, deps)) !== worktree) continue
    try {
      return { path: file, mtimeMs: (await deps.stat(file)).mtimeMs }
    } catch {
      // vanished between listing and stat — keep scanning older rollouts
    }
  }
  return null
}

/**
 * Newest rollout mtime (epoch ms) for `worktree`, or 0 when none match.
 * The Ops pane polls this to detect new Codex conversation output
 * without parsing the tmux pane (KOB-254). Thin wrapper over
 * {@link findLatestRolloutForWorktree}.
 */
export async function latestTranscriptMtimeForWorktree(
  worktree: string,
  deps: HistoryDeps = defaultDeps,
): Promise<number> {
  return (await findLatestRolloutForWorktree(worktree, deps))?.mtimeMs ?? 0
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
    const msg = normalizeCodexResponseItem(payload, ts, sessionId)
    if (msg) out.push(msg)
  }
  return out
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
    // Drop Codex's synthetic user rows. Codex persists both repository
    // instructions and the environment envelope in rollout JSONL as
    // role=user messages, but the live `codex exec --json` stream does
    // not replay them. Reloading history should therefore hide them so
    // the visible transcript matches what the user actually typed.
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
    } else if (latestUsageTimestampMs === null) {
      // No timestamped record has won yet — keep advancing to the latest in
      // FILE order. Gating on `latestUsage === undefined` (the old check) froze
      // on the FIRST snapshot when turn.completed lines carry no timestamp, so
      // every later turn's usage was silently discarded and the session
      // reported stale first-turn tokens.
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
