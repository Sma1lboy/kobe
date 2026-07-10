/**
 * Web-only per-task notes — a free-form markdown scratchpad that lives
 * entirely in the browser dashboard (the TUI has no notes feature).
 *
 * Notes persist server-side as one file per task under
 * `<KOBE_HOME>/.kobe/notes/<taskId>.md`, resolved via {@link kobeStateDir}
 * so they honour `KOBE_HOME_DIR` like every other kobe state path.
 *
 * Routes (composed into the web server's `fetch` before the static/404
 * fallthrough):
 *
 *   GET  /api/notes?taskId=<id>  → { markdown: string }  ("" if absent)
 *   PUT  /api/notes  body {taskId, markdown} → { ok: true }
 *
 * Returns `null` for any other path so the server falls through to its
 * other handlers.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { errorMessage } from "@/lib/error-message"
import { kobeStateDir } from "../env.ts"

const NOTES_ROUTE = "/api/notes"

/** Directory all per-task note files live under. */
function notesDir(): string {
  return join(kobeStateDir(), "notes")
}

/**
 * taskIds are ULID-like alphanumerics. Anything else — path separators,
 * dots (`..`), backslashes, empty — is rejected so a crafted taskId can't
 * escape the notes dir. We allow only `[A-Za-z0-9_-]`.
 */
function isSafeTaskId(taskId: unknown): taskId is string {
  return typeof taskId === "string" && taskId.length > 0 && /^[A-Za-z0-9_-]+$/.test(taskId)
}

function noteFilePath(taskId: string): string {
  return join(notesDir(), `${taskId}.md`)
}

async function handleGet(url: URL): Promise<Response> {
  const taskId = url.searchParams.get("taskId")
  if (!isSafeTaskId(taskId)) {
    return Response.json({ error: "invalid taskId" }, { status: 400 })
  }
  try {
    let markdown = ""
    try {
      markdown = await readFile(noteFilePath(taskId), "utf8")
    } catch (err) {
      // Missing file → empty notes; anything else is a real error.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
    return Response.json({ markdown })
  } catch (err) {
    return Response.json({ error: errorMessage(err) }, { status: 500 })
  }
}

async function handlePut(req: Request): Promise<Response> {
  let body: { taskId?: unknown; markdown?: unknown }
  try {
    body = (await req.json()) as { taskId?: unknown; markdown?: unknown }
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (!isSafeTaskId(body.taskId)) {
    return Response.json({ error: "invalid taskId" }, { status: 400 })
  }
  if (typeof body.markdown !== "string") {
    return Response.json({ error: "markdown must be a string" }, { status: 400 })
  }
  try {
    await mkdir(notesDir(), { recursive: true })
    await writeFile(noteFilePath(body.taskId), body.markdown, "utf8")
    return Response.json({ ok: true })
  } catch (err) {
    return Response.json({ error: errorMessage(err) }, { status: 500 })
  }
}

/**
 * Route handler for the notes API. Returns `null` when `url.pathname`
 * is not a notes route so the caller can fall through to other handlers.
 */
export async function handleNotesRequest(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== NOTES_ROUTE) return null
  if (req.method === "GET") return handleGet(url)
  if (req.method === "PUT") return handlePut(req)
  return Response.json({ error: "method not allowed" }, { status: 405 })
}
