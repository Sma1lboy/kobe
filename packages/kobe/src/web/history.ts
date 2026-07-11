/**
 * Engine history routes for the web dashboard — a structured (non-PTY) view
 * of a task's persisted engine sessions, read through the engine registry's
 * neutral `EngineHistoryReader` so the web never touches a vendor transcript
 * format (CLAUDE.md: engine-owned UI data). Pure filesystem reads next to
 * the user's engine stores; no daemon involvement, mirroring `diff.ts` /
 * `notes.ts` as bridge-local routes.
 *
 * Routes (composed into the web server's `fetch` before the static/404
 * fallthrough):
 *
 *   GET /api/history/sessions?worktreePath=<abs>&vendor=<id>
 *     → { sessions: string[], latestMtime: number }
 *       sessions oldest-first (reader contract); latestMtime is the newest
 *       transcript mtime for the worktree (0 = no transcript yet) — the
 *       SPA polls this cheaply and refetches messages only on change.
 *
 *   GET /api/history/messages?vendor=<id>&sessionId=<id>
 *     → { messages: Message[] }
 *
 * Returns `null` for any other path so the server falls through.
 */

import { isAbsolute } from "node:path"
import { errorMessage } from "@/lib/error-message"
import { engineEntry } from "../engine/registry.ts"

const SESSIONS_ROUTE = "/api/history/sessions"
const MESSAGES_ROUTE = "/api/history/messages"

/** Vendor ids are registry keys / user-registered slugs — never paths. */
function isSafeVendor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value)
}

/**
 * Session ids are vendor-generated (claude UUIDs, codex rollout names) but
 * always flat tokens — anything with a path separator or `..` is rejected
 * so a crafted id can't traverse out of the engine's store.
 */
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
    return Response.json({ error: errorMessage(err) }, { status: 500 })
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
    return Response.json({ error: errorMessage(err) }, { status: 500 })
  }
}

/**
 * Route handler for the history API. Returns `null` when `url.pathname`
 * is not a history route so the caller can fall through.
 */
export async function handleHistoryRequest(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== SESSIONS_ROUTE && url.pathname !== MESSAGES_ROUTE) return null
  if (req.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405 })
  return url.pathname === SESSIONS_ROUTE ? handleSessions(url) : handleMessages(url)
}
