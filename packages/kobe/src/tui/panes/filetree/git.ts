import { parseNumstatRows, parsePorcelainRows } from "@/lib/git-parsers"
import { readWorktreeFile, runWorktreeGit } from "../../../worktree/content.ts"

export type FileStatus = "M" | "A" | "D" | "?" | "R" | "C" | "U" | "T"

export type StatusEntry = {
  path: string
  status: FileStatus
  added?: number | null
  deleted?: number | null
}

export type NumstatEntry = {
  path: string
  added: number | null
  deleted: number | null
}

async function runGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
  if (!cwd) throw new Error("git(): cwd is required")
  const result = await runWorktreeGit(cwd, args, { signal })
  const exitCode = result.status ?? -1
  if (exitCode !== 0) {
    const stderr = (result.stderr ?? "").trim()
    const stdout = (result.stdout ?? "").trim()
    throw new Error(
      `git ${args.join(" ")} (cwd=${cwd}) exited with code ${exitCode}: ${stderr || stdout || "(no output)"}`,
    )
  }
  return result.stdout ?? ""
}

export async function listFiles(worktreePath: string, signal?: AbortSignal): Promise<string[]> {
  const out = await runGit(
    ["ls-files", "--cached", "--others", "--exclude-standard", "--full-name"],
    worktreePath,
    signal,
  )
  const lines = out.split("\n").map((l) => l.replace(/\r$/, ""))
  const set = new Set<string>()
  for (const line of lines) {
    if (line.length > 0) set.add(line)
  }
  return Array.from(set).sort()
}

export async function statusFiles(worktreePath: string, signal?: AbortSignal): Promise<StatusEntry[]> {
  const out = await runGit(["status", "--porcelain", "--untracked-files=all"], worktreePath, signal)
  const entries = parsePorcelain(out)
  let stats: Map<string, { added: number | null; deleted: number | null }> = new Map()
  try {
    const diffOut = await runGit(["diff", "--no-color", "--numstat", "HEAD"], worktreePath, signal)
    stats = new Map(parseNumstat(diffOut).map((n) => [n.path, { added: n.added, deleted: n.deleted }]))
  } catch {
    try {
      const cachedOut = await runGit(["diff", "--no-color", "--numstat", "--cached"], worktreePath, signal)
      stats = new Map(parseNumstat(cachedOut).map((n) => [n.path, { added: n.added, deleted: n.deleted }]))
    } catch {
      stats = new Map()
    }
  }
  const merged = entries.map((e) => {
    const s = stats.get(e.path)
    if (s) return { ...e, added: s.added, deleted: s.deleted }
    return e
  })
  const untracked = merged.filter((e) => e.status === "?" && e.added == null)
  if (untracked.length > 0) {
    await Promise.all(
      untracked.map(async (e) => {
        const added = await countAddedLines(worktreePath, e.path, signal)
        if (added != null) {
          e.added = added
          e.deleted = 0
        }
      }),
    )
  }
  return merged
}

async function countAddedLines(worktreePath: string, relPath: string, signal?: AbortSignal): Promise<number | null> {
  if (signal?.aborted) return null
  const text = await readWorktreeFile(worktreePath, relPath)
  if (text == null) return null
  if (text.includes("\u0000")) return null
  if (text.length === 0) return 0
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") count++
  }
  if (!text.endsWith("\n")) count++
  return count
}

export function parseNumstat(raw: string): NumstatEntry[] {
  return parseNumstatRows(raw).map((r) => ({ path: r.path, added: r.added, deleted: r.deleted }))
}

export type TreeNode = {
  name: string
  path: string
  isDir: boolean
  children: TreeNode[]
}

export function buildTree(paths: readonly string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] }
  for (const p of paths) {
    if (!p) continue
    const segs = p.split("/").filter((s) => s.length > 0)
    if (segs.length === 0) continue
    let cur = root
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i] as string
      const isLast = i === segs.length - 1
      const isDir = !isLast
      let child = cur.children.find((c) => c.name === seg && c.isDir === isDir)
      if (!child) {
        child = {
          name: seg,
          path: segs.slice(0, i + 1).join("/"),
          isDir,
          children: [],
        }
        cur.children.push(child)
      }
      cur = child
    }
  }
  sortTree(root)
  return root
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const c of node.children) sortTree(c)
}

export function parsePorcelain(raw: string): StatusEntry[] {
  const out: StatusEntry[] = []
  for (const row of parsePorcelainRows(raw)) {
    let status: FileStatus
    if (row.x === "?" && row.y === "?") {
      status = "?"
    } else {
      const candidate = row.y !== " " ? row.y : row.x
      if (
        candidate === "M" ||
        candidate === "A" ||
        candidate === "D" ||
        candidate === "R" ||
        candidate === "C" ||
        candidate === "U" ||
        candidate === "T"
      ) {
        status = candidate
      } else {
        continue
      }
    }
    const path = row.path
    if (path.length === 0) continue
    if (path.endsWith("/")) continue
    out.push({ path, status })
  }
  return out
}
