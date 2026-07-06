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
 * {@link Message}; other record types are dropped. Record parsing (and the
 * shared append-aware parse cache) lives in `./history-parse.ts`.
 *
 * Session-lookup-by-UUID requires scanning the date-organized tree
 * because the UUID alone doesn't carry the rollout date — newest-first
 * to bias toward recent sessions. ENOENT / unreadable files are
 * tolerated per-entry so a single corrupt rollout doesn't blank the
 * whole result.
 */

import { readdir, stat, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { EngineHistory, Message } from "@/types/engine"
import { isJsonlLineWithinBound, readTextFileBounded } from "../file-bounds"
import { parseRolloutRaw } from "./history-parse"

export { deriveCodexUsageMetrics, parseJsonl } from "./history-parse"

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
    // Size-bounded: an oversize/corrupt rollout degrades to "" rather than
    // slurping a multi-GB file into memory.
    return await readTextFileBounded(p)
  },
  stat,
}

/**
 * Cap on rollout paths {@link listRolloutFiles} will collect from the date
 * tree. Consistent with the other `MAX_*` scan caps below, this guards the
 * traversal against a pathological/corrupt `~/.codex/sessions` tree with an
 * unbounded number of entries. Newest-first ordering means recent sessions are
 * always covered; older ones past the cap are dropped (noted once, see below).
 * Set well above any realistic session count so normal history is untouched.
 */
const MAX_ROLLOUT_FILES = 5000

/** Warn-once guard so the 1.5–4s pollers don't spam the truncation note. */
let warnedRolloutTruncation = false

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
        for (const f of files) {
          out.push(path.join(dp, f))
          if (out.length >= MAX_ROLLOUT_FILES) {
            if (!warnedRolloutTruncation) {
              warnedRolloutTruncation = true
              console.warn(
                `[codex history] rollout scan truncated at ${MAX_ROLLOUT_FILES} files; older sessions may be omitted`,
              )
            }
            return out
          }
        }
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
    // A mega first line is treated as "no parseable meta" — same as malformed.
    if (!isJsonlLineWithinBound(trimmed)) return ""
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
 * without parsing the tmux pane. Thin wrapper over
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
  return parseRolloutRaw(file, raw, sessionId)
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
