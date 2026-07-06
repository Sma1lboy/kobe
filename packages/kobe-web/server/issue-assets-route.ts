
import { createHash, randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { issueAssetsDir } from "../../kobe/src/env.ts"

const ASSETS_ROUTE = "/api/issue-assets"

const MAX_ASSET_BYTES = 10 * 1024 * 1024

const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

const EXT_CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

function repoHashOf(repoRoot: string): string {
  return createHash("sha1").update(repoRoot).digest("hex").slice(0, 16)
}

const REPO_HASH_RE = /^[a-f0-9]{16}$/
const ASSET_FILE_RE = /^[A-Za-z0-9_-]+\.[a-z0-9]+$/

async function handlePost(req: Request): Promise<Response> {
  const declared = Number.parseInt(req.headers.get("content-length") ?? "", 10)
  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
    return Response.json({ error: "asset too large" }, { status: 413 })
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return Response.json({ error: "invalid form data" }, { status: 400 })
  }

  const repoRoot = form.get("repoRoot")
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    return Response.json({ error: "missing repoRoot" }, { status: 400 })
  }

  const file = form.get("file")
  if (!(file instanceof File)) {
    return Response.json({ error: "file must be a File" }, { status: 400 })
  }
  if (file.size > MAX_ASSET_BYTES) {
    return Response.json({ error: "asset too large" }, { status: 413 })
  }

  const ext = CONTENT_TYPE_EXT[file.type]
  if (!ext) {
    return Response.json({ error: `unsupported content-type: ${file.type || "unknown"}` }, { status: 415 })
  }

  try {
    const repoHash = repoHashOf(repoRoot)
    const dir = join(issueAssetsDir(), repoHash)
    await mkdir(dir, { recursive: true })
    const assetId = randomUUID()
    const name = `${assetId}.${ext}`
    await Bun.write(join(dir, name), file)
    return Response.json({ url: `${ASSETS_ROUTE}/${repoHash}/${name}` })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

async function handleGet(pathname: string): Promise<Response> {
  const rest = pathname.slice(ASSETS_ROUTE.length + 1)
  const slash = rest.indexOf("/")
  if (slash < 0) return Response.json({ error: "not found" }, { status: 404 })
  const repoHash = rest.slice(0, slash)
  const fileSeg = rest.slice(slash + 1)

  if (!REPO_HASH_RE.test(repoHash) || !ASSET_FILE_RE.test(fileSeg)) {
    return Response.json({ error: "invalid asset path" }, { status: 400 })
  }

  const root = issueAssetsDir()
  const resolved = resolve(root, repoHash, fileSeg)
  if (resolved !== join(root, repoHash, fileSeg) || !resolved.startsWith(`${root}/`)) {
    return Response.json({ error: "invalid asset path" }, { status: 400 })
  }

  const ext = fileSeg.slice(fileSeg.lastIndexOf(".") + 1).toLowerCase()
  const contentType = EXT_CONTENT_TYPE[ext]
  if (!contentType) return Response.json({ error: "invalid asset path" }, { status: 400 })

  const file = Bun.file(resolved)
  if (!(await file.exists())) return Response.json({ error: "not found" }, { status: 404 })

  return new Response(file, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  })
}

export async function handleIssueAssetsRequest(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname === ASSETS_ROUTE) {
    if (req.method === "POST") return handlePost(req)
    return Response.json({ error: "method not allowed" }, { status: 405 })
  }
  if (url.pathname.startsWith(`${ASSETS_ROUTE}/`)) {
    if (req.method === "GET") return handleGet(url.pathname)
    return Response.json({ error: "method not allowed" }, { status: 405 })
  }
  return null
}
