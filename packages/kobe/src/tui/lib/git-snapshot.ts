import { spawnSync } from "node:child_process"
import * as fs from "node:fs"

export const DEFAULT_BASE_REF = "main"

function notAGitRepoReason(path: string): string {
  return `This folder isn't a git repository yet, and a task needs a git branch to work in. To fix it, turn ${path} into a repo:  git init && git add -A && git commit -m "init"  — then create the task again. (Working in non-git folders is coming soon.)`
}

export function validateRepoPath(repo: string): string | null {
  const trimmed = repo.trim()
  if (!trimmed) return "repo path is required"
  let stat: fs.Stats
  try {
    stat = fs.statSync(trimmed)
  } catch {
    return `path does not exist: ${trimmed}`
  }
  if (!stat.isDirectory()) return `not a directory: ${trimmed}`
  try {
    const out = spawnSync("git", ["rev-parse", "--git-dir"], {
      cwd: trimmed,
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (out.status !== 0) return notAGitRepoReason(trimmed)
  } catch {
    return notAGitRepoReason(trimmed)
  }
  return null
}

export function getCurrentBranch(repo: string): string | null {
  if (!repo) return null
  try {
    const out = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (out.status !== 0) return null
    const name = out.stdout.trim()
    if (!name || name === "HEAD") return null
    return name
  } catch {
    return null
  }
}

export function listLocalBranches(repo: string): string[] {
  if (!repo) return []
  try {
    const out = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], {
      cwd: repo,
      encoding: "utf-8",
      timeout: 2000,
    })
    if (out.status !== 0) return []
    return out.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort((a, b) => {
        const score = (n: string) => (n === "main" ? 0 : n === "master" ? 1 : n === "develop" ? 2 : 3)
        const sa = score(a)
        const sb = score(b)
        if (sa !== sb) return sa - sb
        return a.localeCompare(b)
      })
  } catch {
    return []
  }
}
