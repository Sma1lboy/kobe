/**
 * kobe web — repo issues route, surfacing a repo's committed
 * `docs/issues.json` backlog (see docs/WORK-TRACKING.md) to the browser
 * dashboard. Pure filesystem reads/writes against the REPO ROOT — never a
 * worktree path, which holds a stale per-branch copy — mirroring `diff.ts` /
 * `notes.ts` as bridge-local routes with no daemon involvement.
 *
 * Routes (composed into the web server's `fetch` before the static/404
 * fallthrough):
 *
 *   GET  /api/issues?repoRoot=<abs>
 *     → { repoRoot, exists, nextId, issues }
 *       Missing file → { repoRoot, exists: false, nextId: 1, issues: [] }
 *       (HTTP 200; GET never creates the file).
 *
 *   POST /api/issues  body { repoRoot, op }
 *     op = { type: "create", title, body? }
 *        | { type: "setStatus", id, status }   status: open|doing|hold|done
 *        | { type: "update", id, title?, body? }
 *     → the same shape as GET (full updated state) so the client can
 *       replace its cache. Unknown id → 404; invalid status/op → 400.
 *
 * Write model: whole-file read-modify-write, single writeFile, mutations
 * serialized per repoRoot by an in-process promise-chain mutex (so two
 * concurrent POSTs can't interleave and lose a write) — the same file
 * contract as scripts/issues-archive.mjs, whose exact serialization
 * (`JSON.stringify(data, null, 2) + "\n"`) is matched so git diffs of
 * docs/issues.json stay clean. `id` is allocated from `nextId` (then
 * incremented) and never reused.
 *
 * Returns `null` for any other path so the server falls through.
 */

import { execFile } from "node:child_process"
import { readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const ISSUES_ROUTE = "/api/issues"

export type IssueStatus = "open" | "doing" | "hold" | "done"

const ISSUE_STATUSES: readonly IssueStatus[] = ["open", "doing", "hold", "done"]

export interface Issue {
  id: number
  title: string
  status: IssueStatus
  created: string
  body: string
}

/** Parsed `docs/issues.json`. Unknown extra keys are preserved on write. */
interface IssuesFile {
  nextId: number
  issues: Issue[]
  [key: string]: unknown
}

interface IssuesState {
  repoRoot: string
  exists: boolean
  nextId: number
  issues: Issue[]
}

function issuesFilePath(repoRoot: string): string {
  return join(repoRoot, "docs", "issues.json")
}

/**
 * Validation ladder for repoRoot (same pattern as diff.ts's worktreePath):
 * must be present → absolute → an existing directory → inside a git work
 * tree. No decodeURIComponent: `url.searchParams.get()` already
 * percent-decodes the query value once, and the POST body is raw JSON —
 * decoding again would mangle paths containing a literal `%`. The rev-parse
 * gate confines writes to actual repos instead of any directory with a
 * `docs/` folder.
 */
async function validateRepoRoot(raw: string | null | undefined): Promise<{ repoRoot: string } | Response> {
  if (!raw || typeof raw !== "string") {
    return Response.json({ error: "missing repoRoot" }, { status: 400 })
  }
  if (!raw.startsWith("/")) {
    return Response.json({ error: "repoRoot must be an absolute path" }, { status: 400 })
  }
  try {
    const s = await stat(raw)
    if (!s.isDirectory()) {
      return Response.json({ error: "repoRoot is not a directory" }, { status: 400 })
    }
  } catch {
    return Response.json({ error: "repoRoot does not exist" }, { status: 400 })
  }
  try {
    const { stdout } = await execFileAsync("git", ["-C", raw, "rev-parse", "--is-inside-work-tree"])
    if (stdout.trim() !== "true") throw new Error("not a work tree")
  } catch {
    return Response.json({ error: "repoRoot is not a git repository" }, { status: 400 })
  }
  return { repoRoot: raw }
}

/**
 * Coerce one hand-edited `issues` entry into the Issue shape, or `null` to
 * skip it: non-objects and entries without a numeric id are dropped; missing
 * or mistyped fields get defaults; an unknown status becomes "open" so the
 * issue still lands in a column instead of silently vanishing.
 */
function normalizeIssue(entry: unknown): Issue | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null
  const raw = entry as Record<string, unknown>
  if (typeof raw.id !== "number") return null
  return {
    id: raw.id,
    title: typeof raw.title === "string" ? raw.title : "(untitled)",
    status: isValidStatus(raw.status) ? raw.status : "open",
    created: typeof raw.created === "string" ? raw.created : "",
    body: typeof raw.body === "string" ? raw.body : "",
  }
}

/**
 * Read + parse `docs/issues.json`. `null` = file absent (ENOENT). Issues are
 * normalized on READ (a GET never rewrites the file); mutations operate on
 * the normalized model, so a later write persists normalized data — the same
 * whole-file read-modify-write contract as everything else here.
 */
async function readIssuesFile(repoRoot: string): Promise<IssuesFile | null> {
  let text: string
  try {
    text = await readFile(issuesFilePath(repoRoot), "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
  const data = JSON.parse(text) as IssuesFile
  if (typeof data.nextId !== "number" || !Array.isArray(data.issues)) {
    throw new Error("malformed docs/issues.json: expected { nextId, issues }")
  }
  data.issues = data.issues.map(normalizeIssue).filter((issue): issue is Issue => issue !== null)
  return data
}

/** Single write point — serialization MUST match scripts/issues-archive.mjs. */
async function writeIssuesFile(repoRoot: string, data: IssuesFile): Promise<void> {
  await writeFile(issuesFilePath(repoRoot), `${JSON.stringify(data, null, 2)}\n`, "utf8")
}

/**
 * Per-repoRoot mutation mutex. Each mutation's read→mutate→write section is
 * chained onto the repo's tail promise so concurrent POSTs can't interleave
 * at the await points (two creates both reading nextId=N, the second write
 * erasing the first). The stored tail is settled (rejections swallowed) so
 * one failed mutation never poisons the chain; the entry is cleaned up when
 * the last waiter finishes.
 */
const locks = new Map<string, Promise<unknown>>()

async function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const tail = locks.get(repoRoot) ?? Promise.resolve()
  const run = tail.then(fn)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  locks.set(repoRoot, settled)
  void settled.then(() => {
    if (locks.get(repoRoot) === settled) locks.delete(repoRoot)
  })
  return run
}

function stateResponse(repoRoot: string, data: IssuesFile): Response {
  const state: IssuesState = { repoRoot, exists: true, nextId: data.nextId, issues: data.issues }
  return Response.json(state)
}

function isValidStatus(value: unknown): value is IssueStatus {
  return typeof value === "string" && (ISSUE_STATUSES as readonly string[]).includes(value)
}

/** Today as YYYY-MM-DD in local time (the `created` convention of the file). */
function todayStamp(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${mm}-${dd}`
}

async function handleGet(url: URL): Promise<Response> {
  const validated = await validateRepoRoot(url.searchParams.get("repoRoot"))
  if (validated instanceof Response) return validated
  const { repoRoot } = validated
  try {
    const data = await readIssuesFile(repoRoot)
    if (data === null) {
      const state: IssuesState = { repoRoot, exists: false, nextId: 1, issues: [] }
      return Response.json(state)
    }
    return stateResponse(repoRoot, data)
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

type Op =
  | { type: "create"; title?: unknown; body?: unknown }
  | { type: "setStatus"; id?: unknown; status?: unknown }
  | { type: "update"; id?: unknown; title?: unknown; body?: unknown }

async function handleCreate(repoRoot: string, op: Op & { type: "create" }): Promise<Response> {
  if (typeof op.title !== "string" || op.title.trim().length === 0) {
    return Response.json({ error: "create requires a non-empty title" }, { status: 400 })
  }
  if (op.body !== undefined && typeof op.body !== "string") {
    return Response.json({ error: "body must be a string" }, { status: 400 })
  }
  let data = await readIssuesFile(repoRoot)
  if (data === null) {
    // First issue: the file is created, but docs/ must already exist — a
    // repo without docs/ shouldn't get one mkdir'd into it by the dashboard.
    try {
      const docs = await stat(join(repoRoot, "docs"))
      if (!docs.isDirectory()) throw new Error("not a directory")
    } catch {
      return Response.json(
        { error: "docs/ does not exist in this repo — create it before tracking issues" },
        { status: 400 },
      )
    }
    data = { nextId: 1, issues: [] }
  }
  const issue: Issue = {
    id: data.nextId,
    title: op.title,
    status: "open",
    created: todayStamp(),
    body: typeof op.body === "string" ? op.body : "",
  }
  // Newest-on-top, matching how the committed backlog file reads.
  data.issues = [issue, ...data.issues]
  data.nextId += 1
  await writeIssuesFile(repoRoot, data)
  return stateResponse(repoRoot, data)
}

async function handleSetStatus(repoRoot: string, op: Op & { type: "setStatus" }): Promise<Response> {
  if (typeof op.id !== "number") {
    return Response.json({ error: "setStatus requires a numeric id" }, { status: 400 })
  }
  if (!isValidStatus(op.status)) {
    return Response.json({ error: `invalid status: must be one of ${ISSUE_STATUSES.join(", ")}` }, { status: 400 })
  }
  const data = await readIssuesFile(repoRoot)
  const issue = data?.issues.find((i) => i.id === op.id)
  if (!data || !issue) {
    return Response.json({ error: `no issue #${op.id}` }, { status: 404 })
  }
  issue.status = op.status
  await writeIssuesFile(repoRoot, data)
  return stateResponse(repoRoot, data)
}

async function handleUpdate(repoRoot: string, op: Op & { type: "update" }): Promise<Response> {
  if (typeof op.id !== "number") {
    return Response.json({ error: "update requires a numeric id" }, { status: 400 })
  }
  if (op.title !== undefined && (typeof op.title !== "string" || op.title.trim().length === 0)) {
    return Response.json({ error: "title must be a non-empty string" }, { status: 400 })
  }
  if (op.body !== undefined && typeof op.body !== "string") {
    return Response.json({ error: "body must be a string" }, { status: 400 })
  }
  const data = await readIssuesFile(repoRoot)
  const issue = data?.issues.find((i) => i.id === op.id)
  if (!data || !issue) {
    return Response.json({ error: `no issue #${op.id}` }, { status: 404 })
  }
  if (typeof op.title === "string") issue.title = op.title
  if (typeof op.body === "string") issue.body = op.body
  await writeIssuesFile(repoRoot, data)
  return stateResponse(repoRoot, data)
}

async function handlePost(req: Request): Promise<Response> {
  let parsed: unknown
  try {
    parsed = await req.json()
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Response.json({ error: "body must be a JSON object" }, { status: 400 })
  }
  const body = parsed as { repoRoot?: unknown; op?: unknown }
  const validated = await validateRepoRoot(typeof body.repoRoot === "string" ? body.repoRoot : null)
  if (validated instanceof Response) return validated
  const { repoRoot } = validated
  const op = body.op as Op | undefined
  if (!op || typeof op !== "object" || typeof op.type !== "string") {
    return Response.json({ error: "missing op" }, { status: 400 })
  }
  try {
    if (op.type === "create") return await withRepoLock(repoRoot, () => handleCreate(repoRoot, op))
    if (op.type === "setStatus") return await withRepoLock(repoRoot, () => handleSetStatus(repoRoot, op))
    if (op.type === "update") return await withRepoLock(repoRoot, () => handleUpdate(repoRoot, op))
    // Exhaustive over Op above, so `op` is `never` here; recover the raw type
    // string for the error message.
    return Response.json({ error: `unknown op type: ${(op as { type: string }).type}` }, { status: 400 })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

/**
 * Route handler for the issues API. Returns `null` when `url.pathname` is
 * not an issues route so the caller can fall through to other handlers.
 */
export async function handleIssuesRequest(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== ISSUES_ROUTE) return null
  if (req.method === "GET") return handleGet(url)
  if (req.method === "POST") return handlePost(req)
  return Response.json({ error: "method not allowed" }, { status: 405 })
}
