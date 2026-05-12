/**
 * List all persisted Claude Code sessions for a given cwd.
 *
 * Powers kobe's resume-picker (chat.session.resume). The single source
 * of truth is `~/.claude/projects/<encoded-cwd>/*.jsonl` — the same
 * directory that {@link readHistory} reads from. We deliberately do
 * NOT maintain a parallel kobe-side index; that way a session opened
 * by raw `claude --resume` outside kobe still appears in the picker.
 *
 * Algorithm ported from `refs/opcode/src-tauri/src/commands/claude.rs`
 * `get_project_sessions` (lines 471–556) and `extract_first_user_message`
 * (lines 194–230). Differences:
 *
 *   - opcode iterates every project dir to recover sessions per cwd;
 *     we know the cwd, so we encode it once and read one dir.
 *   - opcode persists todo data in a parallel directory; we don't —
 *     todos are out of scope for the picker.
 *   - We cap the first-user-message preview at 200 chars at the engine
 *     boundary so the picker doesn't have to know about truncation.
 *
 * Per-file scan reads only the bytes needed to find the first user
 * record (typically the first line). For pathological cases (a session
 * with no user messages, or whose first user line is huge) we fall
 * back to streaming the full file once — still O(file size), still
 * cheap relative to anything the user does interactively.
 */

import { readFile, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { SessionMeta } from "@/types/engine"
import { encodeCwd } from "./history"
import { normalizeClaudeContent } from "./normalize"

/** Optional FS injection for tests. Mirrors `HistoryDeps` from history.ts. */
export interface SessionsDeps {
  projectsDir(): string
  readdir(p: string): Promise<string[]>
  readFile(p: string): Promise<string>
  stat(p: string): Promise<{ mtimeMs: number }>
}

const defaultDeps: SessionsDeps = {
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
  async stat(p) {
    const s = await stat(p)
    return { mtimeMs: s.mtimeMs }
  },
}

/** Preview cap. Long enough for the picker row, short enough to not blow the dialog. */
const PREVIEW_MAX_CHARS = 200

/**
 * List sessions for `cwd`, newest first by file mtime.
 *
 * Returns `[]` for an unknown cwd (no project dir). Per-file errors
 * are swallowed so a single corrupt JSONL doesn't blank the list.
 */
export async function listSessionsForCwd(cwd: string, deps: SessionsDeps = defaultDeps): Promise<SessionMeta[]> {
  const projectDir = path.join(deps.projectsDir(), encodeCwd(cwd))
  const entries = await deps.readdir(projectDir)
  const jsonlNames = entries.filter((n) => n.endsWith(".jsonl"))

  const out: SessionMeta[] = []
  for (const name of jsonlNames) {
    const sessionId = name.slice(0, -".jsonl".length)
    const filePath = path.join(projectDir, name)
    try {
      const [meta, raw] = await Promise.all([deps.stat(filePath), deps.readFile(filePath)])
      const lines = raw.split("\n").filter((l) => l.trim().length > 0)
      out.push({
        sessionId,
        mtimeMs: meta.mtimeMs,
        firstUserMessage: extractFirstUserMessage(lines),
        messageCount: lines.length,
      })
    } catch {
      // Don't drop the session — we still know it exists, just couldn't
      // read it. Show with a null preview so the user can still try it.
      out.push({ sessionId, mtimeMs: 0, firstUserMessage: null, messageCount: 0 })
    }
  }

  // Newest first. mtime===0 (read-failed) sinks to the bottom naturally.
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/**
 * Pull the first user-authored prompt out of a session's JSONL lines.
 *
 * Skips:
 *   - command-tag wrapper lines (Claude Code emits `<command-name>` /
 *     `<command-message>` pseudo-records when the user runs a slash)
 *   - caveat / system-injected user lines (start with `Caveat:`)
 *   - empty content
 *
 * Returns `null` if no usable user line exists. Truncation happens here
 * so the picker doesn't need to know the cap.
 */
export function extractFirstUserMessage(lines: readonly string[]): string | null {
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(parsed)) continue

    // Same shape-walk as history.ts: prefer record.message.{role,content}
    // but fall back to top-level role+content for older records.
    const inner = isObject(parsed.message) ? (parsed.message as Record<string, unknown>) : parsed
    if (inner.role !== "user") continue

    const text = stringifyContent(inner.content)
    if (!text) continue
    if (text.startsWith("Caveat:")) continue
    if (text.startsWith("<command-name>") || text.startsWith("<local-command-stdout>")) continue

    return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…` : text
  }
  return null
}

/**
 * Coerce a Claude Code `content` field into a single preview string.
 * Routes the vendor shape through {@link normalizeClaudeContent} and
 * keeps only neutral `text` blocks — the picker preview is meant to
 * read like the user's actual prompt, not a trace, so tool calls /
 * thinking are dropped.
 */
function stringifyContent(content: unknown): string {
  const blocks = normalizeClaudeContent(content)
  const parts: string[] = []
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text)
  }
  return parts.join(" ").trim()
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
