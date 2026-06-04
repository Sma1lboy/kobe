/**
 * Map a hook's reported `cwd` to a kobe task (KOB).
 *
 * Global activity hooks (`kobe hook <verb>`) fire for EVERY Claude session and
 * carry no task id — only the directory the engine runs in. The daemon resolves
 * that to a task by worktree path here. A task's worktree is the engine's cwd
 * (or an ancestor of it, if the engine cd'd into a subdir), so we take the task
 * whose `worktreePath` is the cwd or the LONGEST path-prefix of it.
 *
 * Longest-prefix matters because task worktrees live UNDER a repo root
 * (`<repo>/.claude/worktrees/<id>`), and a `main` task's worktreePath IS that
 * repo root — so a sub-task's cwd prefix-matches both. The more specific
 * (longer) worktree wins, so a sub-task is never misattributed to the project.
 *
 * cwds that match no task (an unrelated repo, a project root with no main task)
 * return undefined → the event is dropped.
 */

import { KOBE_WORKTREE_ROOT_SUBPATH } from "../orchestrator/worktree/paths.ts"

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
 * Detect a `cwd` that is an UNADOPTED git worktree under a tracked repo's
 * `.claude/worktrees/` dir — the replacement for the removed WorktreeCreate
 * hook. When an external `claude --worktree` (or a manual `git worktree add`)
 * lands a worktree in `<repo>/.claude/worktrees/<seg>` for a repo kobe already
 * has tasks in, the daemon adopts it as a task on the engine's `session-start`.
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
  const seg = `/${KOBE_WORKTREE_ROOT_SUBPATH}/`
  for (const repo of repos) {
    const prefix = `${repo}${seg}`
    if (!target.startsWith(prefix)) continue
    // First path segment after `<repo>/.claude/worktrees/` is the worktree dir.
    const rest = target.slice(prefix.length)
    const name = rest.split("/")[0]
    if (!name) continue
    const worktreePath = `${prefix}${name}`
    if (known.has(worktreePath)) return undefined // already a task → nothing to adopt
    return { repo, worktreePath }
  }
  return undefined
}
