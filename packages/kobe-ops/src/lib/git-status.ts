/**
 * Read `git status --short --branch` for a worktree.
 *
 * Returns the lines as-is (no parsing); the renderer chooses how to
 * format them. Errors are swallowed and surface as an empty list so
 * the watcher loop doesn't crash on a transient lock.
 */

export interface GitStatusEntry {
  /** Raw two-char xy status code (e.g. " M", "??"). */
  readonly code: string
  /** Path relative to the worktree root. */
  readonly path: string
}

export interface GitStatus {
  /** First-line branch info (e.g. "## kobe/foo...origin/main [ahead 1]"). */
  readonly branchLine: string
  readonly entries: readonly GitStatusEntry[]
}

export async function readGitStatus(worktree: string): Promise<GitStatus> {
  try {
    const proc = Bun.spawn(["git", "status", "--short", "--branch"], {
      cwd: worktree,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const text = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code !== 0) return { branchLine: "", entries: [] }
    const lines = text.split("\n")
    let branchLine = ""
    const entries: GitStatusEntry[] = []
    for (const line of lines) {
      if (line.length === 0) continue
      if (line.startsWith("##")) {
        branchLine = line.slice(3).trim()
        continue
      }
      // git status short layout: XY <path>. X = index, Y = worktree.
      const xy = line.slice(0, 2)
      const path = line.slice(3)
      entries.push({ code: xy, path })
    }
    return { branchLine, entries }
  } catch {
    return { branchLine: "", entries: [] }
  }
}
