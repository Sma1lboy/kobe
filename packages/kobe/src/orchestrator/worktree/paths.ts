/**
 * Canonical filesystem layout for kobe-managed worktrees.
 *
 * The worktree root is per-repo and lives adjacent to the source tree
 * at `<repo>/.kobe/worktrees/<slug>/`. `<slug>` is an animal-name slug
 * (KOB-65) for tasks created after the switch, or the task's ULID for
 * older records whose path is already persisted.
 *
 * Backwards compatibility: kobe used `<repo>/.claude/worktrees/<slug>/`
 * before it supported multiple engines. Existing tasks there remain
 * managed and discoverable, but new kobe-created tasks use `.kobe` so
 * neutral task storage is not named after one engine vendor.
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
export const KOBE_WORKTREE_ROOT_SUBPATH = ".kobe/worktrees"
export const LEGACY_KOBE_WORKTREE_ROOT_SUBPATH = ".claude/worktrees"

/**
 * Managed worktree roots, primary first. Creation uses only
 * {@link KOBE_WORKTREE_ROOT_SUBPATH}; recognition/listing checks both.
 */
export const KOBE_MANAGED_WORKTREE_ROOT_SUBPATHS = [
  KOBE_WORKTREE_ROOT_SUBPATH,
  LEGACY_KOBE_WORKTREE_ROOT_SUBPATH,
] as const

/**
 * Absolute path of the worktree root for a given repo.
 *
 * Example: `worktreeRootFor("/Users/x/proj")` →
 * `/Users/x/proj/.kobe/worktrees`.
 */
export function worktreeRootFor(repo: string): string {
  if (!path.isAbsolute(repo)) {
    throw new Error(`worktreeRootFor: repo must be an absolute path, got: ${repo}`)
  }
  return path.join(repo, KOBE_WORKTREE_ROOT_SUBPATH)
}

/**
 * Absolute paths of every worktree root kobe recognizes for `repo`.
 * Primary root is first; legacy roots follow for existing task records.
 */
export function managedWorktreeRootsFor(repo: string): readonly string[] {
  if (!path.isAbsolute(repo)) {
    throw new Error(`managedWorktreeRootsFor: repo must be an absolute path, got: ${repo}`)
  }
  return KOBE_MANAGED_WORKTREE_ROOT_SUBPATHS.map((subpath) => path.join(repo, subpath))
}

/**
 * Absolute path of the worktree directory keyed by `slug` in `repo`.
 *
 * `slug` is the workspace's directory basename — an animal-name slug
 * allocated by {@link SlugAllocator} for tasks created after KOB-65,
 * or the task's ULID for older tasks whose worktree was created back
 * when "dir name == task id" was the invariant.
 *
 * Single source of truth: the orchestrator computes the path via this
 * helper and hands it to {@link import("./manager.ts").GitWorktreeManager.create},
 * so the two modules can never disagree on the layout.
 */
export function worktreePathFor(repo: string, slug: string): string {
  if (!slug || /[/\\\0]/.test(slug)) {
    throw new Error(`worktreePathFor: invalid slug: ${JSON.stringify(slug)}`)
  }
  return path.join(worktreeRootFor(repo), slug)
}

/**
 * Immediate child directory names under every managed root for `repo`.
 *
 * Returns an empty array when no root exists yet (the very
 * first task in a repo) or can't be read. Used by the slug allocator
 * to discover on-disk-occupied slugs (so a stale dir from an aborted
 * task still counts as taken) and by `diagnose` to reconcile the task
 * index against disk state. Symlinks are not followed.
 */
export function listWorktreeDirNames(repo: string): string[] {
  const names = new Set<string>()
  for (const root of managedWorktreeRootsFor(repo)) {
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory()) names.add(e.name)
      }
    } catch {
      // A missing/unreadable root simply contributes no occupied names.
    }
  }
  return [...names]
}

/**
 * Return the caller-form managed root that contains `candidate`, or
 * null when `candidate` is not inside any kobe-managed worktree root
 * for `repo`.
 *
 * Canonicalizes both sides via `fs.realpathSync` when possible so that
 * macOS's `/tmp` ↔ `/private/tmp` symlink aliasing doesn't cause us to
 * miss our own worktrees (git reports the resolved form, helpers return
 * the caller's form).
 */
export function managedWorktreeRootForPath(repo: string, candidate: string): string | null {
  if (!path.isAbsolute(repo) || !path.isAbsolute(candidate)) return null
  const target = canonicalize(candidate)
  for (const rootPath of managedWorktreeRootsFor(repo)) {
    const root = canonicalize(rootPath)
    const rel = path.relative(root, target)
    // path.relative returns ".." prefix when outside; an absolute path
    // when on a different drive (Windows). Either rules it out.
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rootPath
    }
  }
  return null
}

/**
 * True iff `candidate` lives inside a kobe-managed worktree root for
 * `repo`. Used by `list()` to filter out worktrees the user (or another
 * tool) created via plain `git worktree add`.
 */
export function isKobeManagedPath(repo: string, candidate: string): boolean {
  return managedWorktreeRootForPath(repo, candidate) !== null
}

function canonicalize(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}
