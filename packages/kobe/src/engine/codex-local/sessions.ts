/**
 * List every persisted Codex session for a given cwd.
 *
 * Powers the resume-picker. The on-disk layout is:
 *
 *     ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TS>-<UUID>.jsonl
 *
 * The cwd is encoded inside the file (first `session_meta` line) — we
 * read JUST the head of each rollout to recover the id, cwd, and first
 * user message, then filter by cwd. Reading only the first ~20 lines
 * keeps the scan cheap even for years of history.
 */

import { open, stat } from "node:fs/promises"
import type { SessionMeta } from "@/types/engine"
import { type HistoryDeps, listRolloutFiles } from "./history"

const PREVIEW_HEAD_LINES = 40
const PREVIEW_CHAR_CAP = 200

export async function listSessionsForCwd(cwd: string, deps?: HistoryDeps): Promise<SessionMeta[]> {
  const files = await listRolloutFiles(deps)
  const out: SessionMeta[] = []
  for (const file of files) {
    const meta = await tryReadMeta(file)
    if (!meta) continue
    if (meta.cwd !== cwd) continue
    out.push({
      sessionId: meta.sessionId,
      mtimeMs: meta.mtimeMs,
      firstUserMessage: meta.firstUserMessage,
      messageCount: meta.messageCount,
    })
  }
  // Newest-first, mirroring claude-code-local's contract.
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

interface RolloutHead {
  sessionId: string
  cwd: string
  mtimeMs: number
  firstUserMessage: string | null
  /** Approximate; we only count what we read in the head window. */
  messageCount: number
}

async function tryReadMeta(file: string): Promise<RolloutHead | null> {
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(file)
  } catch {
    return null
  }
  let sessionId: string | undefined
  let cwd: string | undefined
  let firstUser: string | null = null
  let messageCount = 0

  const handle = await open(file, "r").catch(() => null)
  if (!handle) return null
  try {
    let buf = ""
    let lineCount = 0
    const processLine = (line: string): boolean => {
      lineCount++
      const parsed = safeParse(line)
      if (parsed) {
        if (parsed.type === "session_meta") {
          const payload = parsed.payload
          if (isObject(payload)) {
            if (typeof payload.id === "string") sessionId = payload.id as string
            if (typeof payload.cwd === "string") cwd = payload.cwd as string
          }
        } else if (parsed.type === "response_item" && isObject(parsed.payload)) {
          const p = parsed.payload as Record<string, unknown>
          if (p.type === "message") {
            messageCount++
            if (!firstUser && p.role === "user") {
              firstUser = extractText(p.content)?.slice(0, PREVIEW_CHAR_CAP) ?? null
            }
          }
        }
      }
      return lineCount >= PREVIEW_HEAD_LINES
    }
    const reader = handle.createReadStream({ encoding: "utf8" })
    outer: for await (const chunk of reader) {
      buf += chunk as string
      let nl = buf.indexOf("\n")
      while (nl !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        nl = buf.indexOf("\n")
        if (processLine(line)) break outer
      }
    }
    if (lineCount < PREVIEW_HEAD_LINES && buf.trim()) processLine(buf)
  } finally {
    await handle.close().catch(() => {})
  }
  if (!sessionId || !cwd) return null
  return {
    sessionId,
    cwd,
    mtimeMs: st.mtimeMs,
    firstUserMessage: firstUser,
    messageCount,
  }
}

function safeParse(line: string): { type?: string; payload?: unknown } | null {
  const t = line.trim()
  if (!t) return null
  try {
    const v = JSON.parse(t)
    return isObject(v) ? (v as { type?: string; payload?: unknown }) : null
  } catch {
    return null
  }
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null
  for (const item of content) {
    if (typeof item === "string" && item.length > 0) return item
    if (isObject(item)) {
      const t = item.type
      if ((t === "input_text" || t === "output_text" || t === "text") && typeof item.text === "string") {
        return item.text as string
      }
    }
  }
  return null
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
