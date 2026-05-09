/**
 * Gather a worktree's git state for the PR-instructions template.
 *
 * We use `node:child_process.spawnSync` with arg arrays (NEVER a shell
 * string) for every git invocation — that way nothing in the worktree
 * path or branch name can be misinterpreted as shell metacharacters. Each
 * call gets a 5s timeout; the worktree path is passed via `cwd:`.
 *
 * Failure model: every git call falls back to a safe default rather than
 * throwing. The PR-creation flow shouldn't get blocked because (e.g.)
 * `origin/HEAD` isn't set on a fresh remote — the agent in chat will see
 * `targetBranch: 'main'` and proceed.
 */

import { spawnSync } from "node:child_process"
import type { PRState } from "./instructions.ts"

/** Per-call git timeout. Keeps the button responsive when git is wedged. */
const GIT_TIMEOUT_MS = 5_000

/** Run git with the given args in `cwd`. Returns stdout (trimmed) on success, null on any failure. */
function git(cwd: string, args: readonly string[]): string | null {
  try {
    const out = spawnSync("git", args.slice(), {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    })
    if (out.error) return null
    if (out.status !== 0) return null
    return (out.stdout ?? "").trim()
  } catch {
    return null
  }
}

/**
 * Detect the current branch. `git rev-parse --abbrev-ref HEAD` returns
 * the branch name on a normal branch, or `HEAD` when detached. We surface
 * `HEAD` literally — the agent can treat it as a hint that there's no
 * branch to push.
 */
function currentBranch(cwd: string): string {
  const out = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  if (!out) return "HEAD"
  return out
}

/**
 * Best-effort target branch.
 *
 * 1. Try `git symbolic-ref refs/remotes/origin/HEAD --short` — this is
 *    set by `git clone` to the remote's default branch.
 * 2. If that fails (no remote, never run `git remote set-head`, etc.),
 *    fall back to `'main'`.
 *
 * The symbolic ref returns `origin/<branch>`; we strip the leading
 * `origin/` to get the bare branch name suitable for `gh pr create --base`.
 */
function targetBranch(cwd: string): string {
  const out = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
  if (!out) return "main"
  // Expected format: `origin/<branch>`. Defensive: if for whatever reason
  // it isn't prefixed, return whatever git gave us.
  return out.startsWith("origin/") ? out.slice("origin/".length) : out
}

/**
 * Whether the current branch resolves `@{u}`. We use `rev-parse
 * --abbrev-ref @{u}` because it returns 0 only when an upstream exists.
 * Detached HEAD or no-upstream both come back as null → false.
 */
function hasUpstream(cwd: string): boolean {
  const out = git(cwd, ["rev-parse", "--abbrev-ref", "@{u}"])
  return out !== null && out.length > 0
}

/**
 * Count uncommitted changes via porcelain output. One line per file.
 * Empty output means clean.
 */
function dirtyCount(cwd: string): number {
  const out = git(cwd, ["status", "--porcelain"])
  if (!out) return 0
  return out.split("\n").filter((line) => line.length > 0).length
}

/**
 * Gather a {@link PRState} from a worktree path. Never throws — each
 * sub-call has its own fallback.
 */
export async function gatherPRState(worktreePath: string): Promise<PRState> {
  return {
    branch: currentBranch(worktreePath),
    targetBranch: targetBranch(worktreePath),
    hasUpstream: hasUpstream(worktreePath),
    dirtyCount: dirtyCount(worktreePath),
  }
}
