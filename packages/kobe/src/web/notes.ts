import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { kobeStateDir } from "../env.ts"

const NOTES_ROUTE = "/api/notes"

function notesDir(): string {
  return join(kobeStateDir(), "notes")
}

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
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
    return Response.json({ markdown })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
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
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function handleNotesRequest(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== NOTES_ROUTE) return null
  if (req.method === "GET") return handleGet(url)
  if (req.method === "PUT") return handlePut(req)
  return Response.json({ error: "method not allowed" }, { status: 405 })
}
