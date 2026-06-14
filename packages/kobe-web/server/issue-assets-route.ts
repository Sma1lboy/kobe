/**
 * kobe web — issue-attachment asset store.
 *
 * A bridge-local filesystem route (style B — no daemon link, mirrors
 * notes-route / diff-route) that lets the Issues panel upload an image and get
 * back a stable URL to embed in an issue body. Uploads happen BEFORE the issue
 * exists, so assets are scoped per-repo (by a hex hash of the repo root), not
 * per-issue.
 *
 * Assets persist server-side under
 * `<KOBE_HOME>/.kobe/issue-assets/<repoHash>/<assetId>.<ext>`, resolved via
 * {@link issueAssetsDir} so they honour `KOBE_HOME_DIR` like every other kobe
 * state path.
 *
 * Routes (composed into the bridge's `fetch` before the static/404
 * fallthrough):
 *
 *   POST /api/issue-assets
 *     multipart/form-data { repoRoot: string, file: File }
 *       → 200 { url: "/api/issue-assets/<repoHash>/<assetId>.<ext>" }
 *       → 400 bad form / missing repoRoot / file not a File
 *       → 413 file larger than MAX_ASSET_BYTES
 *       → 415 content-type not an allowed raster image
 *
 *   GET /api/issue-assets/<repoHash>/<file>
 *       → 200 image bytes (immutable cache, nosniff)
 *       → 400 malformed segments
 *       → 404 missing asset
 *
 * Returns `null` for any other path so the caller can fall through to its other
 * handlers.
 */

import { createHash, randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { issueAssetsDir } from "../../kobe/src/env.ts"

const ASSETS_ROUTE = "/api/issue-assets"

/** 10 MiB upload cap — generous for a screenshot, cheap to store. */
const MAX_ASSET_BYTES = 10 * 1024 * 1024

/**
 * Allowed raster image content-types → file extension. SVG is deliberately
 * DROPPED: it's an XML document that can carry inline scripts, so serving it
 * back would be a stored-XSS vector even with nosniff.
 */
const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

/** Extension → content-type for the GET serve path (inverse allowlist). */
const EXT_CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

/** A repo root hashes to a stable 16-hex-char dir name. */
function repoHashOf(repoRoot: string): string {
  return createHash("sha1").update(repoRoot).digest("hex").slice(0, 16)
}

/** repoHash path segment: exactly 16 lowercase hex chars (a sha1 prefix). */
const REPO_HASH_RE = /^[a-f0-9]{16}$/
/** file path segment: `<assetId>.<ext>` — alnum/_/- name, lowercase-alnum ext. */
const ASSET_FILE_RE = /^[A-Za-z0-9_-]+\.[a-z0-9]+$/

async function handlePost(req: Request): Promise<Response> {
  // Reject oversized uploads up front when the client declares Content-Length,
  // before buffering the body. The post-parse check below is the real guard
  // (Content-Length can lie / be absent).
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
  // pathname is "/api/issue-assets/<repoHash>/<file>" — pull the two segments.
  const rest = pathname.slice(ASSETS_ROUTE.length + 1)
  const slash = rest.indexOf("/")
  if (slash < 0) return Response.json({ error: "not found" }, { status: 404 })
  const repoHash = rest.slice(0, slash)
  const fileSeg = rest.slice(slash + 1)

  if (!REPO_HASH_RE.test(repoHash) || !ASSET_FILE_RE.test(fileSeg)) {
    return Response.json({ error: "invalid asset path" }, { status: 400 })
  }

  // Resolve and confirm the result stays under the asset root — defence in
  // depth on top of the regexes (mirrors the notes/diff traversal guard).
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
      // Asset ids are random UUIDs and never reused, so the bytes at a URL are
      // immutable — let the browser cache them forever.
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  })
}

/**
 * Route handler for the issue-asset store. Returns `null` when `url.pathname`
 * is not an issue-asset route so the caller can fall through to other handlers.
 */
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
