/**
 * Map a hook's reported `cwd` to a kobe task (KOB).
 *
 * Global activity hooks (`kobe hook <verb>`) fire for EVERY Claude session and
 * carry no task id — only the directory the engine runs in. The daemon resolves
 * that to a task by worktree path here. A task's worktree is the engine's cwd
 * (or an ancestor of it, if the engine cd'd into a subdir), so we take the task
 * whose `worktreePath` is the cwd or the LONGEST path-prefix of it.
 *
 * Longest-prefix matters because legacy task worktrees can live under a repo
 * root (`<repo>/.kobe/worktrees/<id>` or `.claude/worktrees/<id>`), and a
 * `main` task's worktreePath IS that repo root. The more specific (longer)
 * worktree wins, so a sub-task is never misattributed to the project.
 *
 * cwds that match no task (an unrelated repo, a project root with no main task)
 * return undefined → the event is dropped.
 */

import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"

const KOBE_WORKTREE_ROOT_DIR = "worktrees"
const REPO_LOCAL_KOBE_WORKTREE_ROOT_SUBPATH = ".kobe/worktrees"
const LEGACY_KOBE_WORKTREE_ROOT_SUBPATH = ".claude/worktrees"
const REPO_LOCAL_KOBE_MANAGED_WORKTREE_ROOT_SUBPATHS = [
  REPO_LOCAL_KOBE_WORKTREE_ROOT_SUBPATH,
  LEGACY_KOBE_WORKTREE_ROOT_SUBPATH,
] as const

function kobeStateDir(): string {
  return path.join(process.env.KOBE_HOME_DIR ?? homedir(), ".kobe")
}

function repoWorktreeDirName(repo: string): string {
  const base = path.basename(repo) || "repo"
  const safeBase = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo"
  const hash = createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 12)
  return `${safeBase}-${hash}`
}

function worktreeRootFor(repo: string): string {
  if (!path.isAbsolute(repo)) {
    throw new Error(`worktreeRootFor: repo must be an absolute path, got: ${repo}`)
  }
  return path.join(kobeStateDir(), KOBE_WORKTREE_ROOT_DIR, repoWorktreeDirName(repo))
}

function managedWorktreeRootsFor(repo: string): readonly string[] {
  if (!path.isAbsolute(repo)) {
    throw new Error(`managedWorktreeRootsFor: repo must be an absolute path, got: ${repo}`)
  }
  return [
    worktreeRootFor(repo),
    ...REPO_LOCAL_KOBE_MANAGED_WORKTREE_ROOT_SUBPATHS.map((subpath) => path.join(repo, subpath)),
  ]
}

export interface CwdMatchTask {
  readonly id: string
  readonly worktreePath?: string | null
  /** The task's repo root — used to know which repos kobe already tracks. */
  readonly repo?: string | null
}

/** Strip a single trailing slash (but keep a bare root "/"). */
function normalize(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p
}

/** True if `wt` is `cwd` itself or a path-segment ancestor of it. */
function isAncestorOrSelf(wt: string, cwd: string): boolean {
  return cwd === wt || cwd.startsWith(`${wt}/`)
}

/**
 * Return the id of the task whose worktree contains `cwd`, preferring the
 * longest (most specific) worktree path, or undefined if none match.
 */
export function matchTaskByCwd(tasks: ReadonlyArray<CwdMatchTask>, cwd: string): string | undefined {
  const target = normalize(cwd)
  let bestId: string | undefined
  let bestLen = -1
  for (const t of tasks) {
    if (!t.worktreePath) continue
    const wt = normalize(t.worktreePath)
    if (isAncestorOrSelf(wt, target) && wt.length > bestLen) {
      bestLen = wt.length
      bestId = t.id
    }
  }
  return bestId
}

/**
 * Map a `cwd` to the tracked repo that CONTAINS it — the longest `repo` root
 * (from the task store) that is `cwd` itself or an ancestor of it.
 *
 * Used by the `worktree.reconcile` path: a `git worktree add` ran in `cwd`, so
 * the freshly-created worktree belongs to whichever tracked repo `cwd` sits
 * under. Returns undefined when no tracked repo contains `cwd` — consistent
 * with {@link findAdoptableWorktree}, kobe only auto-adopts under repos it
 * already tracks.
 */
export function matchRepoByCwd(tasks: ReadonlyArray<CwdMatchTask>, cwd: string): string | undefined {
  const target = normalize(cwd)
  let best: string | undefined
  let bestLen = -1
  for (const t of tasks) {
    if (!t.repo) continue
    const repo = normalize(t.repo)
    if (isAncestorOrSelf(repo, target) && repo.length > bestLen) {
      bestLen = repo.length
      best = repo
    }
  }
  return best
}

/**
 * Detect a `cwd` that is an UNADOPTED git worktree under a tracked repo's
 * managed worktree roots — the replacement for the removed WorktreeCreate
 * hook. When an engine starts in a worktree under `~/.kobe/worktrees/<repo-key>`
 * or a legacy repo-local root for a repo kobe already has tasks in, the daemon
 * adopts it as a task on the engine's `session-start`.
 *
 * Pure + git-free (string paths only, bounded to known repos): returns the
 * `{ repo, worktreePath }` to adopt, or undefined when `cwd` isn't under any
 * tracked repo's worktrees dir or that worktree is already a task. The caller
 * still calls `adoptWorktree` (idempotent + git-validated), so a non-worktree
 * directory that slips through is rejected there.
 */
export function findAdoptableWorktree(
  tasks: ReadonlyArray<CwdMatchTask>,
  cwd: string,
): { repo: string; worktreePath: string } | undefined {
  const target = normalize(cwd)
  const repos = new Set<string>()
  const known = new Set<string>()
  for (const t of tasks) {
    if (t.repo) repos.add(normalize(t.repo))
    if (t.worktreePath) known.add(normalize(t.worktreePath))
  }
  for (const repo of repos) {
    for (const root of managedWorktreeRootsFor(repo).map(normalize)) {
      const prefix = `${root}/`
      if (!target.startsWith(prefix)) continue
      // First path segment after the managed root is the worktree dir.
      const rest = target.slice(prefix.length)
      const name = rest.split("/")[0]
      if (!name) continue
      const worktreePath = `${prefix}${name}`
      if (known.has(worktreePath)) return undefined // already a task → nothing to adopt
      return { repo, worktreePath }
    }
  }
  return undefined
}
