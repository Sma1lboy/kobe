/**
 * Read historical messages from Claude Code's on-disk JSONL.
 *
 * Algorithm ported from `refs/opcode/src-tauri/src/commands/claude.rs`
 * lines 147–230 (cwd-from-first-10-lines fallback) and lines 183–191
 * (lossy slash↔dash decoding).
 *
 * Where Claude Code keeps sessions on disk:
 *
 *     ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *
 * `<encoded-cwd>` is the *absolute* cwd with `/` replaced by `-`, e.g.
 * `/Users/jackson/i/kobe` → `-Users-jackson-i-kobe`. The encoding is
 * **lossy**: a path containing literal `-` collapses to the same
 * directory as a `/`-delimited one (so `foo/bar-baz` and `foo-bar/baz`
 * collide). For session reads we don't need to reverse the encoding —
 * we just iterate every project dir and look for the matching
 * `<sessionId>.jsonl`. That's what opcode does too (the
 * `decode_project_path` helper is documented as deprecated).
 *
 * Each JSONL line is a record like:
 *
 *     { "type": "user", "message": { "role": "user", "content": "..." },
 *       "timestamp": "2026-05-09T03:59:51.343Z",
 *       "sessionId": "<uuid>", "cwd": "/Users/...", ... }
 *
 * The shapes vary — Claude Code persists not just messages but also
 * permission-mode events, file-history snapshots, etc. We filter to
 * records that carry a recognisable role+content pair, so the
 * orchestrator's chat pane only sees actual conversation.
 *
 * `Message.content` is intentionally typed as `unknown` (per
 * src/types/engine.ts §53) — the on-disk shape is sometimes a string,
 * sometimes a content-block array. Renderers narrow per-block.
 */

import { readFile, readdir, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { Message } from "@/types/engine"

/** Optional FS injection for tests. */
export interface HistoryDeps {
  /** Absolute path to the directory holding `<encoded-cwd>` subdirs. */
  projectsDir(): string
  readdir(p: string): Promise<string[]>
  readFile(p: string): Promise<string>
  /** Returns true if the path exists. Used to short-circuit before listing. */
  pathExists(p: string): Promise<boolean>
}

const defaultDeps: HistoryDeps = {
  projectsDir() {
    return path.join(homedir(), ".claude", "projects")
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
  async pathExists(p) {
    try {
      await readdir(p)
      return true
    } catch {
      return false
    }
  },
}

/**
 * Encode a cwd to Claude Code's on-disk project directory name.
 *
 * `/` and `.` are both replaced with `-`. Claude Code itself does this —
 * a directory named `1.2.3` becomes `1-2-3`. The encoding is lossy
 * (see file-level docstring) and reversal is unreliable.
 */
export function encodeCwd(cwd: string): string {
  // Normalize to forward-slashes (paranoia for cross-platform callers
  // building these paths in tests). Then replace runs of `/` and `.`.
  return cwd.replace(/[/.]/g, "-")
}

/**
 * Read all conversation messages persisted for the given session id.
 *
 * Algorithm:
 *   1. List every directory in `~/.claude/projects/`.
 *   2. For each, check if `<dir>/<sessionId>.jsonl` exists.
 *   3. Parse it line by line, keep the lines that look like
 *      conversation records, return them as {@link Message}s.
 *
 * Returns `[]` if the session file isn't found or contains no messages.
 * Never throws on parse failure — bad lines are skipped (Claude Code's
 * JSONL evolves over time and old sessions may have unfamiliar shapes).
 */
export async function readHistory(sessionId: string, deps: HistoryDeps = defaultDeps): Promise<Message[]> {
  const root = deps.projectsDir()
  const projectDirs = await deps.readdir(root)

  for (const dir of projectDirs) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`)
    let raw: string
    try {
      raw = await deps.readFile(candidate)
    } catch {
      continue
    }
    return sortByTimestamp(parseJsonl(raw, sessionId))
  }
  return []
}

/**
 * Permanently delete the JSONL session file for `sessionId`.
 *
 * The file lives at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
 * but the encoded-cwd isn't known at delete time (we don't track which
 * cwd each session was opened in). Same algorithm as {@link readHistory}:
 * scan every project dir, remove the matching file. Tolerates ENOENT
 * (already gone). Returns silently on any other error; the orchestrator
 * logs and proceeds — the user's intent is "discard," not "babysit FS."
 */
export async function deleteHistory(sessionId: string, deps: HistoryDeps = defaultDeps): Promise<void> {
  const root = deps.projectsDir()
  const projectDirs = await deps.readdir(root)
  for (const dir of projectDirs) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`)
    try {
      await unlink(candidate)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue
      // Anything else: surface to the caller. Permission denied / I/O
      // error / etc. — let the orchestrator decide whether to log.
      throw err
    }
  }
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
 */
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
    const msg = extractMessage(parsed, sessionId)
    if (msg) out.push(msg)
  }
  return out
}

function extractMessage(record: Record<string, unknown>, fallbackSessionId: string): Message | null {
  // The on-disk shape commonly looks like:
  //   { type: "user"|"assistant", message: { role, content }, timestamp, sessionId }
  // but older records sometimes have role+content at the top level.
  const inner = isObject(record.message) ? (record.message as Record<string, unknown>) : record

  const role = inner.role
  if (role !== "user" && role !== "assistant" && role !== "system") return null

  // `content` may be a string or a block array. We pass it through as
  // `unknown` per the canonical Message contract.
  if (!("content" in inner)) return null
  const content = inner.content

  const ts = typeof record.timestamp === "string" ? (record.timestamp as string) : new Date().toISOString()
  const sid = typeof record.sessionId === "string" ? (record.sessionId as string) : fallbackSessionId

  return { role, content, timestamp: ts, sessionId: sid }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
