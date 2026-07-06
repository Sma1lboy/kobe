import { isAbsolute } from "node:path"
import { engineEntry } from "../engine/registry.ts"

const SESSIONS_ROUTE = "/api/history/sessions"
const MESSAGES_ROUTE = "/api/history/messages"

function isSafeVendor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value)
}

function isSafeSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && /^[A-Za-z0-9._-]+$/.test(value) && !value.includes("..")
}

async function handleSessions(url: URL): Promise<Response> {
  const worktreePath = url.searchParams.get("worktreePath")
  const vendor = url.searchParams.get("vendor") ?? "claude"
  if (!worktreePath || !isAbsolute(worktreePath)) {
    return Response.json({ error: "worktreePath must be an absolute path" }, { status: 400 })
  }
  if (!isSafeVendor(vendor)) {
    return Response.json({ error: "invalid vendor" }, { status: 400 })
  }
  try {
    const reader = engineEntry(vendor).history
    const [sessions, latestMtime] = await Promise.all([
      reader.listSessionIdsForWorktree(worktreePath),
      reader.latestTranscriptMtimeForWorktree(worktreePath),
    ])
    return Response.json({ sessions, latestMtime })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

async function handleMessages(url: URL): Promise<Response> {
  const vendor = url.searchParams.get("vendor") ?? "claude"
  const sessionId = url.searchParams.get("sessionId")
  if (!isSafeVendor(vendor)) {
    return Response.json({ error: "invalid vendor" }, { status: 400 })
  }
  if (!isSafeSessionId(sessionId)) {
    return Response.json({ error: "invalid sessionId" }, { status: 400 })
  }
  try {
    const messages = await engineEntry(vendor).history.readHistory(sessionId)
    return Response.json({ messages })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function handleHistoryRequest(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== SESSIONS_ROUTE && url.pathname !== MESSAGES_ROUTE) return null
  if (req.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405 })
  return url.pathname === SESSIONS_ROUTE ? handleSessions(url) : handleMessages(url)
}
