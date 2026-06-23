/**
 * One-shot synchronous git snapshots for the task-creation surfaces.
 *
 * Split out of `component/new-task-dialog/state.ts` so the dialog state
 * machine stays pure (no git, no fs, no subprocess) and so this file —
 * and ONLY this file — carries the sync-subprocess whitelist entry in
 * `test/tui/render-path-sync-guard.test.ts`.
 *
 * Why sync is tolerated here (the whitelist rationale): every call is a
 * one-shot **O(refs)** git invocation (`rev-parse`, `for-each-ref`)
 * fired by an explicit dialog action — opening the new-task dialog,
 * editing its repo field, or `kobe quick-task` resolving its defaults.
 * These never run on a render tick / poll loop, and O(refs) is bounded
 * by the repo's branch count, not its working-tree size, so even the
 * 30GB-repo case stays in the low milliseconds. Anything periodic or
 * O(repo size) (status walks, diffs) must instead go through
 * `lib/background-poll.ts` or async spawn — do NOT grow this module in
 * that direction.
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"

/** Default base ref when the user leaves the branch field blank or HEAD can't be read. */
export const DEFAULT_BASE_REF = "main"

/**
 * Validate a repo path entered in the new-task dialog. Returns null
 * when the path looks like a usable git repo, or a human-readable
 * reason string otherwise. The dialog renders the reason inline and
 * blocks submission so a typo'd path doesn't get persisted as
 * `lastNewTaskRepo` and can't drag every subsequent `runTask` into
 * `git worktree add` failures.
 *
 * Two checks (in order):
 *   1. The path exists and is a directory. We do NOT recursively
 *      create — a non-existent path is almost always a typo, not a
 *      "please mkdir for me" request.
 *   2. `git -C <path> rev-parse --git-dir` succeeds. This catches
 *      both "exists but not a repo" and "exists but git is unhappy"
 *      with a single check.
 */
/**
 * Friendly reason for the "exists but isn't a git repo" case. A task is a
 * `git worktree + engine session + branch`, so for now the source dir must
 * already be a git repo — `git worktree add` has nothing to branch from
 * otherwise. Non-git project roots are a planned follow-up; until then we
 * explain the why and hand the user the exact fix instead of leaking git's
 * `fatal: not a git repository`. Rendered with word-wrap, so a full
 * sentence + command is fine here.
 */
function notAGitRepoReason(path: string): string {
  return `This folder isn't a git repository yet, and a task needs a git branch to work in. To fix it, turn ${path} into a repo:  git init && git add -A && git commit -m "init"  — then create the task again. (Working in non-git folders is coming soon.)`
}

export function validateRepoPath(repo: string): string | null {
  const trimmed = repo.trim()
  if (!trimmed) return "repo path is required"
  // existsSync + statSync.isDirectory in one shot.
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

/**
 * Read the current branch of the given repo (whatever HEAD points at).
 * Returns null when the path isn't a repo, HEAD is detached, or git
 * errors out. The dialog uses this to prefill the baseRef field with
 * the repo's actual current branch instead of a hardcoded "main", so
 * a worktree forked from a feature branch defaults to that feature
 * branch rather than silently jumping to main.
 */
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

/**
 * List local branches in the given repo, sorted with the default
 * branch first when present. Synchronous — repo enumeration is a
 * one-shot call driven by the dialog's repo-field changes, so paying
 * for an async boundary buys nothing. Returns [] on any error so the
 * picker just silently degrades to the free-text input.
 */
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
        // Default branches first.
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
