/**
 * Canonical filesystem layout for kobe-managed worktrees.
 *
 * Per DESIGN.md §11.3 (resolved) the worktree root is per-repo and lives
 * adjacent to the source tree at `<repo>/.claude/worktrees/<task-id>/`.
 * Shared namespace with Claude Code's own agent-spawn worktrees — one
 * hidden dir, both tools' worktrees inside. Do NOT move this back to
 * `.kobe/worktrees/`; that proposal pre-dates Jackson's resolution and
 * keeps cropping up in stale comments / test fixtures. Search-and-replace
 * any survivors when you find them.
 *
 * Keeping this in one place means the orchestrator, the worktree
 * manager, the task index, and any future "list all kobe worktrees"
 * tool agree on where to look — no string concatenation scattered
 * across modules.
 *
 * `<repo>` is always absolute. Callers must normalize before invoking.
 */

import fs from "node:fs"
import path from "node:path"

/**
 * Directory under each repo where kobe stores all of its worktrees.
 *
 * Exposed so the worktree manager's `list()` implementation can scope
 * its enumeration to "kobe-managed only" without reaching into another
 * module's private constant.
 */
export const KOBE_WORKTREE_ROOT_SUBPATH = ".claude/worktrees"

/**
 * Absolute path of the worktree root for a given repo.
 *
 * Example: `worktreeRootFor("/Users/x/proj")` →
 * `/Users/x/proj/.claude/worktrees`.
 */
export function worktreeRootFor(repo: string): string {
  if (!path.isAbsolute(repo)) {
    throw new Error(`worktreeRootFor: repo must be an absolute path, got: ${repo}`)
  }
  return path.join(repo, KOBE_WORKTREE_ROOT_SUBPATH)
}

/**
 * Absolute path of the worktree assigned to `taskId` in `repo`.
 *
 * Single source of truth — the orchestrator (Wave 2 Stream E) will
 * compute the path via this helper and hand it to
 * {@link import("./manager.ts").GitWorktreeManager.create}, so the two
 * modules can never disagree.
 */
export function worktreePathFor(repo: string, taskId: string): string {
  if (!taskId || /[/\\\0]/.test(taskId)) {
    throw new Error(`worktreePathFor: invalid taskId: ${JSON.stringify(taskId)}`)
  }
  return path.join(worktreeRootFor(repo), taskId)
}

/**
 * True iff `candidate` lives inside the kobe-managed worktree root for
 * `repo`. Used by `list()` to filter out worktrees the user (or another
 * tool) created via plain `git worktree add`.
 *
 * Canonicalizes both sides via `fs.realpathSync` when possible so that
 * macOS's `/tmp` ↔ `/private/tmp` symlink aliasing doesn't cause us to
 * miss our own worktrees (git reports the resolved form,
 * `worktreeRootFor()` returns the caller's form).
 */
export function isKobeManagedPath(repo: string, candidate: string): boolean {
  if (!path.isAbsolute(repo) || !path.isAbsolute(candidate)) return false
  const root = canonicalize(worktreeRootFor(repo))
  const target = canonicalize(candidate)
  const rel = path.relative(root, target)
  // path.relative returns ".." prefix when outside; an absolute path
  // when on a different drive (Windows). Either rules it out.
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function canonicalize(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}
