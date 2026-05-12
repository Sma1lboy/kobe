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

import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises"
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

  const usage = extractUsage(inner.usage)
  return usage
    ? { role, content, timestamp: ts, sessionId: sid, usage }
    : { role, content, timestamp: ts, sessionId: sid }
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Append (or merge into) the session JSONL a synthetic user record so
 * an interrupted `claude -p` turn isn't lost to the model on the next
 * `--resume`.
 *
 * Background — `claude -p` writes records to disk only at well-defined
 * turn boundaries; if we SIGTERM/SIGKILL the subprocess before it
 * reaches one (which is exactly what a steer or ESC interrupt does),
 * the user message it was processing is never persisted. The next
 * `--resume <sid>` then reads a JSONL that's missing the abandoned
 * prompt, so the model is blind to whatever the user had been saying.
 * The fix is to rescue the prompt into the JSONL ourselves on stop.
 *
 * Merge-vs-append rule: scan backwards for the most recent
 * conversational (user/assistant) record. If it's a user record (an
 * earlier kill that already rescued a prompt, with no assistant reply
 * since), concatenate this prompt into its content rather than
 * appending a second consecutive user record — back-to-back user
 * turns are not a shape the model API accepts after a `--resume`.
 * If it's an assistant record (or the file is empty), append a
 * fresh user record.
 *
 * File-not-exists is tolerated: claude may have died before its very
 * first record landed; we create the parent directory and write the
 * record as the first line. Any other I/O error surfaces to the
 * caller (engine.stop logs + swallows so the steer flow doesn't
 * hard-fail on a permissions hiccup).
 *
 * Schema — minimum keys needed for {@link readHistory}'s parser AND
 * for claude's own `--resume` reader to recognise it:
 *
 *     { type: "user", message: { role: "user", content: <text> },
 *       uuid, parentUuid, sessionId, cwd, timestamp,
 *       isSidechain: false, userType: "external", version: "1.0.0" }
 *
 * `parentUuid` chains the record to the prior turn so claude's resume
 * walker doesn't see it as an orphan. `uuid` is a fresh v4.
 */
export async function appendInterruptedUserPrompt(
  sessionId: string,
  cwd: string,
  prompt: string,
  deps: HistoryDeps = defaultDeps,
): Promise<void> {
  if (!prompt || prompt.trim().length === 0) return

  const projectDir = path.join(deps.projectsDir(), encodeCwd(cwd))
  const filePath = path.join(projectDir, `${sessionId}.jsonl`)

  let lines: string[] = []
  try {
    const raw = await readFile(filePath, "utf8")
    lines = raw.split("\n").filter((l) => l.length > 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    await mkdir(projectDir, { recursive: true })
  }

  // Scan backwards for the most recent user/assistant record. Skip
  // non-conversational records (tool results, summaries, etc.) so the
  // merge check looks at semantic turns, not file-tail noise.
  let lastConvIdx = -1
  let lastConvRecord: Record<string, unknown> | null = null
  let lastConvRole: "user" | "assistant" | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: unknown
    try {
      parsed = JSON.parse(lines[i] as string)
    } catch {
      continue
    }
    if (!isObject(parsed)) continue
    const inner = isObject(parsed.message) ? (parsed.message as Record<string, unknown>) : parsed
    const role = inner.role
    if (role === "user" || role === "assistant") {
      lastConvIdx = i
      lastConvRecord = parsed
      lastConvRole = role
      break
    }
  }

  const now = new Date().toISOString()

  if (lastConvRole === "user" && lastConvRecord && lastConvIdx >= 0) {
    const inner = isObject(lastConvRecord.message)
      ? (lastConvRecord.message as Record<string, unknown>)
      : lastConvRecord
    const existing = typeof inner.content === "string" ? inner.content : ""
    // Idempotency / race-safety: claude may have flushed the user
    // record just before our SIGTERM landed (or a prior rescue call
    // already merged this same prompt). Skip if the last user record
    // already ends with our prompt — re-injecting would double up
    // the message in the model's context.
    if (existing === prompt || existing.endsWith(`\n\n${prompt}`)) return
    // Merge into the prior rescued-user record. Concatenating with a
    // blank-line separator keeps each prompt readable as its own
    // paragraph; the model sees them as a single user turn.
    inner.content = existing.length > 0 ? `${existing}\n\n${prompt}` : prompt
    lastConvRecord.timestamp = now
    lines[lastConvIdx] = JSON.stringify(lastConvRecord)
    await writeFile(filePath, `${lines.join("\n")}\n`)
    return
  }

  const parentUuid = lastConvRecord && typeof lastConvRecord.uuid === "string" ? (lastConvRecord.uuid as string) : null
  const record = {
    type: "user",
    message: { role: "user", content: prompt },
    uuid: randomUUID(),
    parentUuid,
    sessionId,
    cwd,
    timestamp: now,
    isSidechain: false,
    userType: "external",
    version: "1.0.0",
  }
  await appendFile(filePath, `${JSON.stringify(record)}\n`)
}
