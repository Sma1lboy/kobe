/**
 * Build a depth-limited tree view of a directory using `git ls-files`
 * (so node_modules / .git / gitignored junk is excluded for free).
 *
 * Returns an array of pre-rendered lines so the watcher can blit them
 * directly. Errors are swallowed to an empty list — the Ops pane keeps
 * showing the previous tree if the lock is held mid-write.
 */

import { dirname, sep } from "node:path"

const MAX_DEPTH = 2
const MAX_LINES = 200

export async function readTree(worktree: string): Promise<string[]> {
  try {
    const proc = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: worktree,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const text = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code !== 0) return []
    const paths = text.split("\0").filter((p) => p.length > 0)
    return formatTree(paths)
  } catch {
    return []
  }
}

function formatTree(paths: readonly string[]): string[] {
  // Group by directory at depth 0/1/2.
  const dirs = new Set<string>()
  const filesByDir = new Map<string, string[]>()
  for (const path of paths) {
    const segments = path.split("/")
    if (segments.length === 1) {
      const list = filesByDir.get("") ?? []
      list.push(segments[0]!)
      filesByDir.set("", list)
      continue
    }
    // For deeper paths, record each ancestor up to MAX_DEPTH.
    for (let depth = 0; depth < Math.min(segments.length - 1, MAX_DEPTH); depth++) {
      dirs.add(segments.slice(0, depth + 1).join("/"))
    }
    if (segments.length - 1 <= MAX_DEPTH) {
      const parent = segments.slice(0, -1).join("/")
      const list = filesByDir.get(parent) ?? []
      list.push(segments[segments.length - 1]!)
      filesByDir.set(parent, list)
    }
  }
  const sortedDirs = ["", ...Array.from(dirs).sort((a, b) => a.localeCompare(b))]
  const lines: string[] = []
  for (const dir of sortedDirs) {
    if (lines.length >= MAX_LINES) {
      lines.push("…")
      break
    }
    if (dir !== "") {
      const depth = dir.split("/").length - 1
      lines.push(`${"  ".repeat(depth)}${basename(dir)}/`)
    }
    const files = (filesByDir.get(dir) ?? []).sort((a, b) => a.localeCompare(b))
    for (const file of files) {
      if (lines.length >= MAX_LINES) {
        lines.push("…")
        break
      }
      const depth = dir === "" ? 0 : dir.split("/").length
      lines.push(`${"  ".repeat(depth)}${file}`)
    }
  }
  return lines
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/")
  return idx >= 0 ? path.slice(idx + 1) : path
}

// Silence the unused-import lint when sep / dirname aren't used by
// platform-specific branches.
void sep
void dirname
