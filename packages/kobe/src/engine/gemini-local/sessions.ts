import { readFile, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { SessionMeta } from "@/types/engine"
import { type GeminiHistoryDeps, listChatFiles, parseConversation } from "./history"

const PREVIEW_CHAR_CAP = 200

export async function listSessionsForCwd(cwd: string, deps?: GeminiHistoryDeps): Promise<SessionMeta[]> {
  const actualDeps = deps ?? defaultDeps
  const projectIds = await projectIdentifiersForCwd(cwd, actualDeps)
  if (projectIds.size === 0) return []
  const bySessionId = new Map<string, SessionMeta>()
  for (const file of await listChatFiles(actualDeps)) {
    const projectId = path.basename(path.dirname(path.dirname(file)))
    if (!projectIds.has(projectId)) continue
    const raw = await actualDeps.readFile(file).catch(() => "")
    const conversation = parseConversation(raw)
    if (!conversation || conversation.kind === "subagent") continue
    const st = await stat(file).catch(() => null)
    const next: SessionMeta = {
      sessionId: conversation.sessionId,
      mtimeMs: st?.mtimeMs ?? Date.parse(conversation.lastUpdated),
      firstUserMessage: (conversation.firstUserMessage ?? null)?.slice(0, PREVIEW_CHAR_CAP) ?? null,
      messageCount: conversation.messages.length,
    }
    const prev = bySessionId.get(next.sessionId)
    if (!prev || next.mtimeMs > prev.mtimeMs) bySessionId.set(next.sessionId, next)
  }
  const out = [...bySessionId.values()]
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

async function projectIdentifiersForCwd(cwd: string, deps: GeminiHistoryDeps): Promise<Set<string>> {
  const normalized = path.resolve(cwd)
  const ids = new Set<string>()
  const projectsRaw = await deps.readFile(path.join(deps.geminiDir(), "projects.json")).catch(() => "")
  if (projectsRaw) {
    try {
      const parsed = JSON.parse(projectsRaw) as unknown
      if (isObject(parsed) && isObject(parsed.projects)) {
        for (const [projectPath, id] of Object.entries(parsed.projects)) {
          if (typeof id === "string" && samePath(projectPath, normalized)) ids.add(id)
        }
      }
    } catch {
      /* ignore corrupt registry */
    }
  }
  for (const base of [path.join(deps.geminiDir(), "tmp"), path.join(deps.geminiDir(), "history")]) {
    for (const id of await deps.readdir(base)) {
      const marker = await deps.readFile(path.join(base, id, ".project_root")).catch(() => "")
      if (marker && samePath(marker.trim(), normalized)) ids.add(id)
    }
  }
  return ids
}

function samePath(a: string, b: string): boolean {
  const ar = path.resolve(a)
  const br = path.resolve(b)
  if (process.platform === "win32" || process.platform === "darwin") return ar.toLowerCase() === br.toLowerCase()
  return ar === br
}

const defaultDeps: GeminiHistoryDeps = {
  geminiDir() {
    return path.join(homedir(), ".gemini")
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
  async unlink() {},
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
