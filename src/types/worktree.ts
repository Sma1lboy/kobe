/**
 * Worktree manager — kobe's wrapper around `git worktree`.
 *
 * See DESIGN.md §5.3 (orchestrator owns worktree manager) and §11.3
 * (open question: worktree root location, proposed
 * `<repo>/.kobe/worktrees/<task-id>/`).
 *
 * The orchestrator depends on this interface; Stream B (Wave 1) will
 * ship `GitWorktreeManager` against it. The orchestrator must never
 * shell out to `git worktree` directly — always go through this seam,
 * so error handling, dirty detection, and path conventions live in
 * exactly one place.
 */

/**
 * Snapshot of a worktree on disk.
 *
 * `path` is absolute; `head` is the commit SHA; `dirty` is true iff
 * `git status --porcelain` returns any entries (untracked or modified).
 */
export interface WorktreeInfo {
  readonly path: string
  readonly branch: string
  readonly head: string
  readonly dirty: boolean
}

/**
 * Manager for git worktrees mapped 1:1 to kobe Tasks.
 *
 * Conventions / invariants the impl must hold:
 * - `create()` is responsible for creating the branch if it doesn't
 *   exist. If the branch exists and points elsewhere, `create()` must
 *   reject — never silently fast-forward or hijack a branch.
 * - `remove()` refuses to remove a dirty worktree unless `force=true`.
 *   This is the single most important safety property here.
 * - `list()` enumerates ONLY worktrees managed by kobe (i.e. under the
 *   kobe worktree root convention), not all worktrees on the repo.
 * - All paths in/out are absolute. No tilde expansion, no relative
 *   paths — caller normalizes before calling.
 * - All git invocations use argv arrays, never shell strings. No
 *   string concatenation into a shell.
 */
export interface WorktreeManager {
  /**
   * Create a worktree at `path` for `branch` rooted in `repo`.
   *
   * Guarantees: on success, `path` exists, contains a checked-out
   * working tree on `branch`, and is registered in the repo's
   * worktree list. On failure, no partial state is left behind
   * (best-effort cleanup before throwing).
   */
  create(repo: string, branch: string, path: string): Promise<WorktreeInfo>

  /**
   * Remove a worktree previously created with {@link create}.
   *
   * Guarantees: refuses to remove a dirty worktree unless `force` is
   * true. On success, the directory is gone, the worktree is
   * deregistered from the repo, and the branch is left in place.
   */
  remove(path: string, opts?: { readonly force?: boolean }): Promise<void>

  /**
   * List all kobe-managed worktrees under `repo`.
   *
   * Guarantees: returns only worktrees inside the kobe convention root
   * (per DESIGN.md §11.3). Results are stable across calls when the
   * filesystem is unchanged.
   */
  list(repo: string): Promise<readonly WorktreeInfo[]>

  /**
   * Whether a worktree has uncommitted or untracked changes.
   *
   * Guarantees: equivalent to `git -C <path> status --porcelain` being
   * non-empty. Submodules are intentionally NOT recursed (matches git
   * default).
   */
  isDirty(path: string): Promise<boolean>

  /**
   * The branch currently checked out at `path`.
   *
   * Guarantees: returns the short branch name (no `refs/heads/`
   * prefix). Throws if `path` is detached HEAD or not a worktree.
   */
  currentBranch(path: string): Promise<string>
}
