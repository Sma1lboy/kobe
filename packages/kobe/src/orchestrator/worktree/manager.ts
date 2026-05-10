/**
 * `GitWorktreeManager` — Stream B's deliverable.
 *
 * Implements `WorktreeManager` from `src/types/worktree.ts`. Wraps
 * `git worktree add/remove/list` plus the few status probes (dirty,
 * current branch) that the orchestrator and the sidebar need.
 *
 * Invariants preserved here (matching the interface contract):
 *   - `create()` is idempotent. If a worktree already lives at `path`
 *     and is checked out on `branch`, we return its info. If the path
 *     exists with a *different* branch, we throw — never hijack.
 *   - `create()` makes the branch when it doesn't yet exist (rooted at
 *     the repo's current HEAD), and reuses the existing branch when it
 *     does. We never silently fast-forward a branch that already has
 *     work on it.
 *   - `remove()` refuses to delete a dirty worktree unless `force` is
 *     true. The single most important safety property of this module:
 *     "I lost my changes because kobe deleted the worktree" must be
 *     impossible without explicit consent.
 *   - `list()` only returns worktrees inside `<repo>/.claude/worktrees/`
 *     (the convention from DESIGN.md §11 / PLAN.md §B). Worktrees the
 *     user created outside this root are invisible to kobe.
 *
 * Reference (read, not ported): `refs/vibe-kanban/crates/worktree-manager/`
 * for cleanup invariants and dirty-state semantics.
 */

import fs from "node:fs"
import path from "node:path"
import type { WorktreeInfo, WorktreeManager } from "../../types/worktree.ts"
import { GitCommandError, git } from "./git.ts"
import { isKobeManagedPath, worktreePathFor, worktreeRootFor } from "./paths.ts"

export class GitWorktreeManager implements WorktreeManager {
  /**
   * Create a worktree at `path` for `branch` rooted in `repo`.
   *
   * Idempotent: if a worktree already exists at `path` on the requested
   * branch, returns its info without touching the filesystem. If a
   * worktree exists on the *wrong* branch, throws — we never hijack.
   *
   * `baseRef` (optional): when the branch is being created fresh, this
   * is the ref the new branch is rooted at — a branch name, tag, or
   * commit SHA, anything `git worktree add -b <new> <path> <baseRef>`
   * accepts. Defaults to the repo's current HEAD. When the requested
   * branch already exists, `baseRef` is ignored: we never silently
   * fast-forward an existing branch onto a new base.
   *
   * Note: the public `WorktreeManager` interface is `(repo, branch,
   * path, baseRef?)` (positional). The brief from the orchestrator
   * described an options-object form. We satisfy the canonical
   * interface and expose a small helper {@link createForTask} for the
   * options-object call style; that helper composes
   * {@link worktreePathFor} so callers don't have to.
   */
  async create(repo: string, branch: string, worktreePath: string, baseRef?: string): Promise<WorktreeInfo> {
    requireAbsolute("repo", repo)
    requireAbsolute("path", worktreePath)
    if (!branch) throw new Error("create(): branch must be a non-empty string")

    // Idempotent fast-path: already a worktree here, on the right branch.
    if (fs.existsSync(worktreePath)) {
      const existing = await this.tryDescribe(repo, worktreePath)
      if (existing) {
        if (existing.branch !== branch) {
          throw new Error(
            `worktree at ${worktreePath} is on branch '${existing.branch}', refusing to hijack to '${branch}'`,
          )
        }
        return existing
      }
      // Path exists but isn't a worktree — almost certainly a stale
      // directory from a prior failed run. Don't silently nuke; the
      // user might have files in there. Surface the conflict.
      throw new Error(`create(): ${worktreePath} exists but is not a registered git worktree`)
    }

    // Make sure the parent dir exists (`.claude/worktrees/` may be the
    // first time we write into the repo).
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true })

    // Decide whether to create the branch. `git worktree add -b <new>`
    // creates a fresh branch from HEAD (or `baseRef` when given);
    // `git worktree add <path> <existing>` reuses one. We probe with
    // `rev-parse` and pick.
    //
    // Note: `baseRef` only applies on the create-branch path. If the
    // branch already exists, the user's choice of baseRef has no
    // sensible meaning here (we'd either be lying or silently rebasing
    // their branch); the orchestrator surfaces the resulting state via
    // the existing branch, not via the now-ignored baseRef.
    const branchExists = this.branchExists(repo, branch)
    const args = branchExists
      ? ["worktree", "add", worktreePath, branch]
      : baseRef
        ? ["worktree", "add", "-b", branch, worktreePath, baseRef]
        : ["worktree", "add", "-b", branch, worktreePath]

    git(args, { cwd: repo })

    // Sanity-check the result so any failure surfaces here, not at the
    // first downstream `currentBranch()` call.
    const info = await this.tryDescribe(repo, worktreePath)
    if (!info) {
      throw new Error(`create(): git reported success but ${worktreePath} is not a worktree`)
    }
    if (info.branch !== branch) {
      throw new Error(
        `create(): post-condition failed — expected branch '${branch}' at ${worktreePath}, got '${info.branch}'`,
      )
    }
    return info
  }

  /**
   * Convenience wrapper for the orchestrator: create a worktree for a
   * task. Computes the canonical path via {@link worktreePathFor} so
   * the caller doesn't have to (and so two callers can't disagree on
   * the layout).
   *
   * `baseRef` (optional): forwarded to {@link create} so the new branch
   * can be rooted at an explicit ref instead of the repo's current HEAD.
   * The new-task dialog passes this through when the user chose a
   * non-default base branch.
   */
  async createForTask(args: {
    repo: string
    taskId: string
    branch: string
    baseRef?: string
  }): Promise<WorktreeInfo> {
    const target = worktreePathFor(args.repo, args.taskId)
    return this.create(args.repo, args.branch, target, args.baseRef)
  }

  /**
   * Remove a worktree. Refuses to remove a dirty worktree unless
   * `opts.force` is true.
   *
   * On success the directory is gone, the worktree is deregistered
   * from the repo's metadata, and the branch is left in place (per
   * interface contract — caller decides branch lifecycle).
   */
  async remove(worktreePath: string, opts?: { readonly force?: boolean }): Promise<void> {
    requireAbsolute("path", worktreePath)
    const force = opts?.force === true

    if (!fs.existsSync(worktreePath)) {
      // Best-effort metadata prune — the directory may be gone but a
      // stale entry can survive in `.git/worktrees/`. `git worktree
      // remove` will refuse, so we use prune.
      const repo = this.findRepoFor(worktreePath)
      if (repo) git(["worktree", "prune"], { cwd: repo, allowFail: true })
      return
    }

    // Resolve the owning repo via `rev-parse --git-common-dir` from
    // inside the worktree itself. This is the only reliable way to get
    // back to the main repo when the caller hands us only the path.
    const repo = this.findRepoFor(worktreePath)
    if (!repo) {
      throw new Error(`remove(): ${worktreePath} is not a git worktree`)
    }

    if (!force) {
      const dirty = await this.isDirty(worktreePath)
      if (dirty) {
        throw new Error(
          `remove(): refusing to remove dirty worktree at ${worktreePath} (pass { force: true } to override)`,
        )
      }
    }

    // `--force` here is the git CLI's "remove even if locked / has
    // submodule mods" flag. Even with our `force=false` early-out, we
    // pass --force to git so an unlocked-but-untracked-files case (rare
    // — we already checked dirty) doesn't bounce. Dirty refusal lives
    // in our layer, not git's.
    const args = force ? ["worktree", "remove", "--force", worktreePath] : ["worktree", "remove", worktreePath]
    git(args, { cwd: repo })

    // Defensive prune — cleans up `.git/worktrees/<name>/` if the
    // remove left it behind (rare, but documented in vibe-kanban).
    git(["worktree", "prune"], { cwd: repo, allowFail: true })
  }

  /**
   * List kobe-managed worktrees under `repo`.
   *
   * Parses `git worktree list --porcelain` and filters to entries
   * whose path lives inside `<repo>/.claude/worktrees/`. Worktrees the
   * user created elsewhere are invisible to kobe — we don't enumerate
   * the whole world.
   */
  async list(repo: string): Promise<readonly WorktreeInfo[]> {
    requireAbsolute("repo", repo)
    const out = git(["worktree", "list", "--porcelain"], { cwd: repo })
    const all = parsePorcelain(out.stdout)

    // Re-root paths into the caller's form. Git on macOS reports
    // `/private/var/...` but the caller passed in `/var/...`; we hand
    // back paths that satisfy `path.startsWith(worktreeRootFor(repo))`
    // so callers can use string ops without surprise.
    const callerRoot = worktreeRootFor(repo)
    const canonRoot = canonicalize(callerRoot)

    const infos: WorktreeInfo[] = []
    for (const entry of all) {
      if (!entry.path) continue
      if (!isKobeManagedPath(repo, entry.path)) continue
      // Detached / bare entries don't have a branch we care about.
      if (!entry.branch || entry.detached) continue
      const canonEntry = canonicalize(entry.path)
      const rel = path.relative(canonRoot, canonEntry)
      const callerPath = path.join(callerRoot, rel)
      const dirty = await this.isDirty(entry.path)
      infos.push({
        path: callerPath,
        branch: entry.branch,
        head: entry.head ?? "",
        dirty,
      })
    }
    return infos
  }

  /**
   * `git -C <path> status --porcelain` non-empty.
   *
   * Untracked files count as dirty (matches `--porcelain` default) —
   * this matters because a fresh worktree with new files we haven't
   * yet committed should not be silently nuked by `remove()`.
   */
  async isDirty(worktreePath: string): Promise<boolean> {
    requireAbsolute("path", worktreePath)
    const out = git(["status", "--porcelain"], { cwd: worktreePath })
    return out.stdout.length > 0
  }

  /**
   * Short branch name at HEAD of `worktreePath`.
   *
   * Throws when the worktree is in detached-HEAD state (rev-parse
   * returns the literal string `HEAD`). Detached-HEAD worktrees can
   * exist after a hard reset; surfacing rather than returning a
   * meaningless string is safer for the orchestrator.
   */
  async currentBranch(worktreePath: string): Promise<string> {
    requireAbsolute("path", worktreePath)
    const out = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath })
    const name = out.stdout.trim()
    if (!name || name === "HEAD") {
      throw new Error(`currentBranch(): ${worktreePath} is in detached-HEAD state`)
    }
    return name
  }

  /**
   * Rename a branch in-place. Used by the orchestrator's lazy
   * branch-naming flow: a fresh worktree is allocated on a temp
   * `kobe/tmp-<ulid>` branch, claude is asked to suggest a slug, and
   * we rename once the suggestion lands.
   *
   * git's `branch -m <old> <new>` updates HEAD on every worktree that
   * was checked out on `<old>` — the engine's session keeps streaming
   * without noticing.
   *
   * Idempotent: returns silently when `from === to`. If `to` already
   * exists, throws.
   */
  async renameBranch(worktreePath: string, from: string, to: string): Promise<void> {
    requireAbsolute("path", worktreePath)
    if (from === to) return
    const repo = this.findRepoFor(worktreePath)
    if (!repo) throw new Error(`renameBranch(): ${worktreePath} is not a git worktree`)
    git(["branch", "-m", from, to], { cwd: repo })
  }

  // ---------- internals ----------

  /**
   * Read a single worktree's info if it's actually registered with the
   * repo at `repo`. Returns null if `path` exists on disk but isn't a
   * git worktree. This is how `create()`'s idempotency check
   * distinguishes "already done" from "stale debris".
   */
  private async tryDescribe(repo: string, worktreePath: string): Promise<WorktreeInfo | null> {
    const out = git(["worktree", "list", "--porcelain"], { cwd: repo })
    const entries = parsePorcelain(out.stdout)
    const target = canonicalize(worktreePath)
    const match = entries.find((e) => e.path && canonicalize(e.path) === target)
    if (!match || !match.path || !match.branch || match.detached) return null
    return {
      // Return the caller's requested path verbatim — they passed in
      // `<repo>/.claude/worktrees/<id>` and may compare against that
      // exact string later. Returning git's macOS-resolved
      // `/private/...` form would surprise them.
      path: worktreePath,
      branch: match.branch,
      head: match.head ?? "",
      dirty: await this.isDirty(match.path),
    }
  }

  /**
   * Whether `branch` exists in `repo`. Uses `show-ref --verify --quiet`
   * which exits 0/1 cleanly without touching working tree state.
   */
  private branchExists(repo: string, branch: string): boolean {
    const ref = `refs/heads/${branch}`
    const out = git(["show-ref", "--verify", "--quiet", ref], { cwd: repo, allowFail: true })
    return out.exitCode === 0
  }

  /**
   * Resolve the repo (the directory containing the `.git` directory)
   * that owns the worktree at `worktreePath`. Returns null when
   * `worktreePath` isn't a worktree.
   *
   * `git rev-parse --git-common-dir` returns the path to the *shared*
   * git dir (i.e. the main repo's `.git`); its parent is the repo
   * working tree.
   */
  private findRepoFor(worktreePath: string): string | null {
    try {
      const out = git(["rev-parse", "--git-common-dir"], { cwd: worktreePath, allowFail: true })
      if (out.exitCode !== 0) return null
      const gitDir = out.stdout.trim()
      if (!gitDir) return null
      const absolute = path.isAbsolute(gitDir) ? gitDir : path.resolve(worktreePath, gitDir)
      // git-common-dir points at `<repo>/.git`. Parent is the working
      // tree we want to invoke further git calls from.
      const base = path.basename(absolute)
      return base === ".git" ? path.dirname(absolute) : absolute
    } catch (err) {
      if (err instanceof GitCommandError) return null
      throw err
    }
  }
}

interface RawWorktree {
  path?: string
  head?: string
  branch?: string
  detached?: boolean
  bare?: boolean
}

/**
 * Parse `git worktree list --porcelain` output into structured
 * entries. Format reference (`man git-worktree`, "PORCELAIN FORMAT"):
 *   worktree <path>
 *   HEAD <sha>
 *   branch refs/heads/<name>     # OR
 *   detached
 *   bare                         # OR
 *   locked [<reason>]
 *   prunable [<reason>]
 *   <blank line separates records>
 */
function parsePorcelain(out: string): RawWorktree[] {
  const records: RawWorktree[] = []
  let current: RawWorktree | null = null
  for (const rawLine of out.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (line === "") {
      if (current) records.push(current)
      current = null
      continue
    }
    if (!current) current = {}
    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length)
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length)
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length)
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref
    } else if (line === "detached") {
      current.detached = true
    } else if (line === "bare") {
      current.bare = true
    }
  }
  if (current) records.push(current)
  return records
}

function requireAbsolute(name: string, value: string): void {
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path, got: ${JSON.stringify(value)}`)
  }
}

/**
 * Resolve symlinks on a path so two strings that name the same node
 * compare equal. Necessary on macOS where `/tmp` and `/var/folders/...`
 * are symlinks into `/private/`. Falls back to `path.resolve` if the
 * path doesn't exist (we're sometimes asked about a target that's not
 * yet created).
 */
function canonicalize(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}
