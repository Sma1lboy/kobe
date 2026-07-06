import { statSync } from "node:fs"
import { execHostForWorktreePath, worktreeUsable } from "../exec/resolve.ts"
import { unquoteGitPath } from "../lib/git-parsers.ts"
import { runWorktreeGit } from "../worktree/content.ts"

const GIT_TIMEOUT_MS = 15_000

const UNTRACKED_DIFF_CONCURRENCY = 8

interface SpawnResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

async function runGit(cwd: string, args: string[]): Promise<SpawnResult> {
  const res = await runWorktreeGit(cwd, args, { timeoutMs: GIT_TIMEOUT_MS })
  const code = res.status ?? -1
  return { ok: code === 0, stdout: res.stdout, stderr: res.stderr, code }
}

export interface DiffFile {
  path: string
  status: string
  staged: boolean
  patch: string
}

export interface DiffResult {
  files: DiffFile[]
  raw: string
}

export function statusLabel(code: string): string {
  switch (code) {
    case "M":
      return "modified"
    case "A":
      return "added"
    case "D":
      return "deleted"
    case "R":
      return "renamed"
    case "C":
      return "copied"
    case "T":
      return "type changed"
    case "U":
      return "unmerged"
    case "?":
      return "untracked"
    default:
      return "changed"
  }
}

function markerPath(payload: string): string | null {
  if (payload === "/dev/null") return null
  let token = payload
  if (token.startsWith('"')) {
    token = unquoteGitPath(token)
  } else {
    const tab = token.indexOf("\t")
    if (tab >= 0) token = token.slice(0, tab)
  }
  if (token.startsWith("a/") || token.startsWith("b/")) token = token.slice(2)
  return token.length > 0 ? token : null
}

export function splitDiffByFile(diff: string): Map<string, string> {
  const byFile = new Map<string, string>()
  if (!diff) return byFile
  const chunks = diff.split(/(?=^diff --git )/m)
  for (const chunk of chunks) {
    if (!chunk.startsWith("diff --git")) continue
    let path: string | null = null
    const plus = chunk.match(/^\+\+\+ (.*)$/m)
    if (plus) path = markerPath(plus[1])
    if (path === null) {
      const minus = chunk.match(/^--- (.*)$/m)
      if (minus) path = markerPath(minus[1])
    }
    if (path === null) {
      const header = chunk.match(/^diff --git a\/.* b\/(.*)$/m)
      if (header) path = unquoteGitPath(header[1])
    }
    if (path === null) continue
    byFile.set(path, chunk.endsWith("\n") ? chunk : `${chunk}\n`)
  }
  return byFile
}

export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  const width = Math.max(1, Math.min(limit, items.length))
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()))
  return results
}

async function untrackedPatch(cwd: string, relPath: string): Promise<string> {
  const res = await runGit(cwd, ["diff", "--no-color", "--no-index", "--", "/dev/null", relPath])
  if (res.stdout.trim()) return res.stdout.endsWith("\n") ? res.stdout : `${res.stdout}\n`
  return ""
}

export async function handleDiffRequest(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== "/api/diff") return null
  if (req.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405 })

  const rawParam = url.searchParams.get("worktreePath")
  if (!rawParam) return Response.json({ error: "missing worktreePath" }, { status: 400 })

  let worktreePath: string
  try {
    worktreePath = decodeURIComponent(rawParam)
  } catch {
    return Response.json({ error: "invalid worktreePath encoding" }, { status: 400 })
  }
  if (!worktreePath.startsWith("/")) {
    return Response.json({ error: "worktreePath must be an absolute path" }, { status: 400 })
  }

  if (!worktreeUsable(worktreePath)) {
    return Response.json({ error: "worktreePath does not exist" }, { status: 400 })
  }
  const host = execHostForWorktreePath(worktreePath)
  if (!host.isRemote) {
    try {
      if (!statSync(worktreePath).isDirectory()) {
        return Response.json({ error: "worktreePath is not a directory" }, { status: 400 })
      }
    } catch {
      return Response.json({ error: "worktreePath does not exist" }, { status: 400 })
    }
  }

  const inside = await runGit(worktreePath, ["rev-parse", "--is-inside-work-tree"])
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return Response.json({ error: `not a git work tree: ${inside.stderr.trim() || worktreePath}` }, { status: 500 })
  }

  const [statusRes, unstaged, staged] = await Promise.all([
    runGit(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    runGit(worktreePath, ["diff", "--no-color"]),
    runGit(worktreePath, ["diff", "--no-color", "--staged"]),
  ])

  if (!statusRes.ok) {
    return Response.json({ error: `git status failed: ${statusRes.stderr.trim()}` }, { status: 500 })
  }

  const unstagedByFile = splitDiffByFile(unstaged.stdout)
  const stagedByFile = splitDiffByFile(staged.stdout)

  const records = statusRes.stdout.split("\0")
  const files: DiffFile[] = []
  const untrackedJobs: Array<{ fileIndex: number; path: string }> = []
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue
    const x = rec[0] ?? " "
    const y = rec[1] ?? " "
    const path = rec.slice(3)
    if (!path) continue
    if (x === "R" || x === "C" || y === "R" || y === "C") i++

    const untracked = x === "?" && y === "?"
    const code = x !== " " && x !== "?" ? x : y
    const staged = x !== " " && x !== "?"

    let patch = ""
    if (untracked) {
      untrackedJobs.push({ fileIndex: files.length, path })
    } else {
      patch = stagedByFile.get(path) ?? unstagedByFile.get(path) ?? ""
      if (stagedByFile.has(path) && unstagedByFile.has(path)) {
        patch = `${stagedByFile.get(path)}${unstagedByFile.get(path)}`
      }
    }

    files.push({
      path,
      status: untracked ? "untracked" : statusLabel(code),
      staged,
      patch,
    })
  }

  if (untrackedJobs.length > 0) {
    const patches = await mapPool(untrackedJobs, UNTRACKED_DIFF_CONCURRENCY, (job) =>
      untrackedPatch(worktreePath, job.path),
    )
    for (let j = 0; j < untrackedJobs.length; j++) {
      files[untrackedJobs[j].fileIndex].patch = patches[j]
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path))

  const raw = [staged.stdout, unstaged.stdout].filter(Boolean).join("\n")
  const result: DiffResult = { files, raw }
  return Response.json(result)
}
