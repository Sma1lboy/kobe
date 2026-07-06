import { spawnSync } from "node:child_process"
import { readOnlyGitProcessEnv } from "@/lib/git-env"
import { parsePorcelainRows } from "@/lib/git-parsers"

export interface WorktreeChanges {
  readonly added: number
  readonly deleted: number
}

const ZERO: WorktreeChanges = { added: 0, deleted: 0 }

export function sameWorktreeChanges(a: WorktreeChanges, b: WorktreeChanges): boolean {
  return a.added === b.added && a.deleted === b.deleted
}

export function pickPushedChanges(
  pushed: ReadonlyMap<string, WorktreeChanges> | null | undefined,
  worktreePath: string,
): WorktreeChanges | null {
  if (!pushed) return null
  return pushed.get(worktreePath) ?? ZERO
}

export function readWorktreeChanges(worktreePath: string): WorktreeChanges {
  if (!worktreePath) return ZERO
  try {
    const out = spawnSync("git", ["status", "--porcelain=v1"], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: readOnlyGitProcessEnv(),
    })
    if (out.status !== 0 || !out.stdout) return ZERO
    return parsePorcelain(out.stdout)
  } catch {
    return ZERO
  }
}

export function parsePorcelain(text: string): WorktreeChanges {
  let added = 0
  let deleted = 0
  for (const { x, y } of parsePorcelainRows(text)) {
    if (x === "D" || y === "D") deleted += 1
    else added += 1
  }
  return { added, deleted }
}
