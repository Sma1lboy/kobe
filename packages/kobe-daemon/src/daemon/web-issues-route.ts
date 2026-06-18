import type { DaemonRpcClient } from "../client/rpc.ts"

const ISSUES_ROUTE = "/api/issues"

function errorResponse(err: unknown, status = 500): Response {
  return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status })
}

function statusForIssueError(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err)
  if (/^no issue #\d+$/.test(message)) return 404
  if (
    message === "repoRoot is required" ||
    message === "repoRoot does not exist" ||
    message === "repoRoot is not a git repository" ||
    message === "missing op" ||
    message === "create requires a non-empty title" ||
    message === "body must be a string" ||
    message === "setStatus requires a numeric id" ||
    message.startsWith("invalid status:") ||
    message === "update requires a numeric id" ||
    message === "title must be a non-empty string" ||
    message === "link requires a numeric id" ||
    message === "link requires a non-empty taskId" ||
    message === "unlink requires a numeric id" ||
    message === "delete requires a numeric id" ||
    message.startsWith("unknown op type:")
  ) {
    return 400
  }
  return 500
}

async function handleGet(link: DaemonRpcClient, url: URL): Promise<Response> {
  const repoRoot = url.searchParams.get("repoRoot")
  if (!repoRoot) return Response.json({ error: "missing repoRoot" }, { status: 400 })
  try {
    return Response.json(await link.request("issue.list", { repoRoot }))
  } catch (err) {
    return errorResponse(err, statusForIssueError(err))
  }
}

async function handlePost(link: DaemonRpcClient, req: Request): Promise<Response> {
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
  if (typeof body.repoRoot !== "string" || body.repoRoot.length === 0) {
    return Response.json({ error: "missing repoRoot" }, { status: 400 })
  }
  try {
    return Response.json(await link.request("issue.mutate", { repoRoot: body.repoRoot, op: body.op }))
  } catch (err) {
    return errorResponse(err, statusForIssueError(err))
  }
}

export async function handleIssuesRequest(req: Request, url: URL, link: DaemonRpcClient): Promise<Response | null> {
  if (url.pathname !== ISSUES_ROUTE) return null
  if (req.method === "GET") return handleGet(link, url)
  if (req.method === "POST") return handlePost(link, req)
  return Response.json({ error: "method not allowed" }, { status: 405 })
}
