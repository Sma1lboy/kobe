/**
 * Committed-work signals for `collect`: how far a task branch has moved
 * from its base. `readWorktreeChanges` only counts UNCOMMITTED files, so a
 * task that commits its work reads `+0 −0` — exactly when the caller is
 * choosing a fan-out winner. These helpers add the committed side:
 * ahead-of-base commit count and a diffstat vs the merge-base.
 *
 * The fan-out `--base-branch` is one-shot input (a side-map consumed at
 * worktree creation, not durable Task state), so the base is re-resolved
 * here the same way the worktrees page does: `origin/HEAD` → `origin/main`
 * → `origin/master` → local `main`/`master`. All reads are lock-free
 * (`GIT_OPTIONAL_LOCKS=0`) and best-effort — a repo with no resolvable
 * base yields nulls, never an error.
 */

import { spawnSync } from "node:child_process"
import { readOnlyGitProcessEnv } from "../../lib/git-env.ts"

export interface BranchSignals {
  /** Base ref the signals were computed against; null = none resolvable. */
  readonly baseRef: string | null
  /** `git rev-list --count <base>..HEAD`; null when base is unresolvable. */
  readonly ahead: number | null
  /** Committed diff vs the merge-base (`git diff --shortstat <base>...HEAD`). */
  readonly diff: { files: number; insertions: number; deletions: number } | null
}

const NONE: BranchSignals = { baseRef: null, ahead: null, diff: null }

function git(cwd: string, args: readonly string[]): string | null {
  try {
    const out = spawnSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: readOnlyGitProcessEnv(),
    })
    return out.status === 0 ? out.stdout.trim() : null
  } catch {
    return null
  }
}

/** `origin/HEAD` → `origin/main` → `origin/master` → `main` → `master`. */
export function resolveBaseRef(worktreePath: string): string | null {
  const head = git(worktreePath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
  if (head) return head
  for (const guess of ["origin/main", "origin/master", "main", "master"]) {
    if (git(worktreePath, ["rev-parse", "--verify", "--quiet", guess]) !== null) return guess
  }
  return null
}

/**
 * Parse `git diff --shortstat` output, e.g.
 * ` 3 files changed, 40 insertions(+), 2 deletions(-)` — any clause may be
 * absent. An empty string is a real result: zero committed changes.
 */
export function parseShortstat(text: string): { files: number; insertions: number; deletions: number } {
  const num = (re: RegExp): number => {
    const m = text.match(re)
    return m ? Number.parseInt(m[1] ?? "0", 10) : 0
  }
  return {
    files: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/),
  }
}

export function readBranchSignals(worktreePath: string): BranchSignals {
  if (!worktreePath) return NONE
  const baseRef = resolveBaseRef(worktreePath)
  if (!baseRef) return NONE
  const aheadOut = git(worktreePath, ["rev-list", "--count", `${baseRef}..HEAD`])
  const ahead = aheadOut === null ? null : Number.parseInt(aheadOut, 10)
  // Three-dot: diff from the merge-base, so drift on the base branch since
  // the fork point doesn't pollute the task's own stats.
  const statOut = git(worktreePath, ["diff", "--shortstat", `${baseRef}...HEAD`])
  const diff = statOut === null ? null : parseShortstat(statOut)
  return { baseRef, ahead: ahead !== null && Number.isNaN(ahead) ? null : ahead, diff }
}
