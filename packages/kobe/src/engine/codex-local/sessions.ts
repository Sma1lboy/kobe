/**
 * List every persisted Codex session for a given cwd.
 *
 * Powers the resume-picker. The on-disk layout is:
 *
 *     ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TS>-<UUID>.jsonl
 *
 * The cwd is encoded inside the file (first `session_meta` line). We
 * scan the whole rollout because `messageCount` is the count the
 * resume-picker shows — capping at the head window systematically
 * under-reports any session longer than the window. The scan is still
 * line-by-line streaming, so memory cost stays bounded.
 */

import { open, stat } from "node:fs/promises"
import type { SessionMeta } from "@/types/engine"
import { type HistoryDeps, listRolloutFiles } from "./history"
import { visibleCodexUserText } from "./synthetic"

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
    const processLine = (line: string): void => {
      const parsed = safeParse(line)
      if (!parsed) return
      if (parsed.type === "session_meta") {
        const payload = parsed.payload
        if (isObject(payload)) {
          if (typeof payload.id === "string") sessionId = payload.id as string
          if (typeof payload.cwd === "string") cwd = payload.cwd as string
        }
        return
      }
      if (parsed.type === "response_item" && isObject(parsed.payload)) {
        const p = parsed.payload as Record<string, unknown>
        if (p.type === "message") {
          messageCount++
          if (!firstUser && p.role === "user") {
            const text = visibleCodexUserText(p.content)
            if (text) firstUser = text.slice(0, PREVIEW_CHAR_CAP)
          }
        }
      }
    }
    const reader = handle.createReadStream({ encoding: "utf8" })
    for await (const chunk of reader) {
      buf += chunk as string
      let nl = buf.indexOf("\n")
      while (nl !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        nl = buf.indexOf("\n")
        processLine(line)
      }
    }
    if (buf.trim()) processLine(buf)
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
