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
 * On-disk `content` is sometimes a bare string and sometimes a Claude
 * content-block array. We normalize both shapes through
 * {@link normalizeClaudeContent} and surface the vendor-neutral
 * `Message.blocks` union (see src/types/content.ts).
 */

import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { Message } from "@/types/engine"
import { isJsonlLineWithinBound, readTextFileBounded } from "../file-bounds"
import { isObject, parseSessionRaw } from "./history-parse"

// Parsing (JSONL → Message[], sorting, and the append-aware per-file cache)
// lives in ./history-parse; re-exported here for existing consumers/tests.
export { parseJsonl } from "./history-parse"

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
    // Size-bounded: an oversize/corrupt transcript degrades to "" (an empty
    // session) rather than slurping a multi-GB file into memory.
    return await readTextFileBounded(p)
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

/** One persisted Claude session file under a worktree's project dir. */
export interface WorktreeSessionFile {
  /** Session UUID (the JSONL filename without extension). */
  readonly sessionId: string
  /** Absolute path to the `.jsonl`. */
  readonly path: string
  /** File mtime in epoch ms — newest = most recent activity. */
  readonly mtimeMs: number
}

/**
 * List every Claude session transcript persisted for `worktree`.
 *
 * Owns the `~/.claude/projects/<encoded-cwd>/*.jsonl` directory layout
 * knowledge so callers (the monitor's cost dashboard, future recap)
 * don't re-derive it. Sorted newest-first by mtime. Returns `[]` when
 * the worktree has no project dir yet (a task never entered). Never
 * throws — best-effort scan.
 */
export async function listSessionFilesForWorktree(worktree: string): Promise<WorktreeSessionFile[]> {
  if (!worktree) return []
  const dir = path.join(homedir(), ".claude", "projects", encodeCwd(worktree))
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const out: WorktreeSessionFile[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue
    const full = path.join(dir, entry)
    let mtimeMs = 0
    try {
      mtimeMs = (await stat(full)).mtimeMs
    } catch {
      // keep mtime 0; the file may have vanished between readdir and stat
    }
    out.push({ sessionId: entry.slice(0, -".jsonl".length), path: full, mtimeMs })
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/**
 * Newest transcript mtime (epoch ms) for `worktree`, or 0 when the task
 * was never entered / has no session files. The Ops pane polls this to
 * detect "the agent produced new conversation output" without parsing
 * the tmux pane (KOB-254). `listSessionFilesForWorktree` already sorts
 * newest-first, so `[0]` is the most recent activity.
 */
export async function latestTranscriptMtimeForWorktree(worktree: string): Promise<number> {
  const files = await listSessionFilesForWorktree(worktree)
  return files[0]?.mtimeMs ?? 0
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
 *
 * Consecutive calls for the same file are append-aware: the unchanged
 * prefix is served from a per-file parse cache with stable Message object
 * identities (see ./history-parse), so the polling chat pane doesn't churn
 * row identity — a rewrite/truncation falls back to a full re-parse.
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
    return parseSessionRaw(candidate, raw, sessionId)
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
 * Append-only — this never rewrites the file. Scan backwards for the
 * most recent conversational (user/assistant) record to decide how to
 * chain the new record:
 *   - assistant record (or empty file): append a fresh user record
 *     chained to it (`parentUuid` = that record's `uuid`).
 *   - user record (an earlier kill that already rescued a prompt, with
 *     no assistant reply since): coalesce — carry that turn's text
 *     forward into the new record and chain to its PARENT, superseding
 *     it as a same-parent sibling. claude's `--resume` walker follows
 *     the newest leaf, so the model sees ONE coalesced user turn (never
 *     two back-to-back user records — a shape the API rejects), and the
 *     older sibling is left on disk untouched.
 *
 * Why append-only: the engine is mid-stop when this runs and claude may
 * still be flushing buffered records to the same JSONL. The previous
 * read-all-then-`writeFile`-the-whole-file merge clobbered any record
 * flushed after our read snapshot. `appendFile` (O_APPEND) writes at the
 * live EOF, so concurrent flushes survive; a stale snapshot can only
 * mis-chain `parentUuid`, never lose data.
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
    // Size-bounded: an oversize/corrupt transcript degrades to "" (we then
    // append a fresh rescue record instead of trying to merge) rather than
    // loading a giant file just to scan its tail.
    const raw = await readTextFileBounded(filePath)
    lines = raw.split("\n").filter((l) => l.length > 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    await mkdir(projectDir, { recursive: true })
  }

  // Scan backwards for the most recent user/assistant record. Skip
  // non-conversational records (tool results, summaries, etc.) so the
  // coalesce check looks at semantic turns, not file-tail noise.
  let lastConvRecord: Record<string, unknown> | null = null
  let lastConvRole: "user" | "assistant" | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string
    if (!isJsonlLineWithinBound(line)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(parsed)) continue
    const inner = isObject(parsed.message) ? (parsed.message as Record<string, unknown>) : parsed
    const role = inner.role
    if (role === "user" || role === "assistant") {
      lastConvRecord = parsed
      lastConvRole = role
      break
    }
  }

  const now = new Date().toISOString()

  // Append-only — NEVER rewrite the file. The previous implementation
  // edited the prior user record in place and `writeFile`-rewrote the
  // WHOLE file from this in-memory snapshot. That snapshot is taken while
  // the engine is mid-stop and claude may still be flushing buffered
  // records (an assistant reply, tool results) to the same JSONL; a
  // full-file rewrite would truncate anything flushed after our read →
  // silent data loss. `appendFile` writes at the current EOF (O_APPEND),
  // so a concurrent flush is preserved no matter when it lands; a stale
  // snapshot can now only mis-chain `parentUuid`, never destroy records.
  let content = prompt
  let parentUuid = lastConvRecord && typeof lastConvRecord.uuid === "string" ? (lastConvRecord.uuid as string) : null

  if (lastConvRole === "user" && lastConvRecord) {
    const inner = isObject(lastConvRecord.message)
      ? (lastConvRecord.message as Record<string, unknown>)
      : lastConvRecord
    const existing = typeof inner.content === "string" ? inner.content : ""
    // Idempotency / race-safety: claude may have flushed the user record
    // just before our SIGTERM landed (or a prior rescue already coalesced
    // this same prompt). Skip if the last user record already ends with
    // our prompt — re-injecting would double it in the model's context.
    if (existing === prompt || existing.endsWith(`\n\n${prompt}`)) return
    // Coalesce: carry the prior user turn's text forward (blank-line
    // separated) and chain the new record to the prior turn's PARENT, so
    // it supersedes the un-replied user turn as a same-parent sibling
    // rather than following it. claude's `--resume` walker follows the
    // newest leaf for a given parent (the standard rewind/branch model,
    // see the DAG note on `sortByTimestamp`), so the model sees ONE
    // coalesced user turn — never two back-to-back user records — while
    // the older sibling stays on disk untouched (no clobber).
    content = existing.length > 0 ? `${existing}\n\n${prompt}` : prompt
    parentUuid = typeof lastConvRecord.parentUuid === "string" ? (lastConvRecord.parentUuid as string) : null
  }

  const record = {
    type: "user",
    message: { role: "user", content },
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
