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
 *   - `list()` only returns worktrees inside kobe-managed roots
 *     (`~/.kobe/worktrees/<repo-key>/` plus repo-local compatibility roots).
 *     Worktrees the user created outside these roots are invisible to kobe.
 *
 * Reference (read, not ported): `refs/vibe-kanban/crates/worktree-manager/`
 * for cleanup invariants and dirty-state semantics.
 */

import fs from "node:fs"
import path from "node:path"
import type { ExecHost } from "../../exec/exec-host.ts"
import { execHostForRepo, execHostForWorktreePath } from "../../exec/resolve.ts"
import { getRemoteRepoConfig } from "../../state/repos.ts"
import type { AdoptableWorktree, WorktreeInfo, WorktreeManager } from "../../types/worktree.ts"
import { GitCommandError, type GitRunOpts, type GitRunResult } from "./git.ts"
import { isKobeManagedPath, managedWorktreeRootForPath, remoteWorktreePathFor, worktreePathFor } from "./paths.ts"

/**
 * Resolver seam so a REMOTE project's worktree work runs over SSH while a
 * LOCAL project keeps today's `spawnSync`+`fs` behavior verbatim. Injected so
 * tests can stub remoteness without a real host. See `docs/design/remote-projects.md`.
 */
export interface WorktreeExecDeps {
  /** ExecHost for a project KEY (local path or `ssh://…`). */
  execForRepo(repoKey: string): ExecHost
  /** ExecHost for a WORKTREE PATH (recovered by basePath match). */
  execForPath(worktreePath: string): ExecHost
  /** The remote base path for a project key, or null when the project is local. */
  remoteBasePath(repoKey: string): string | null
}

const defaultExecDeps: WorktreeExecDeps = {
  execForRepo: execHostForRepo,
  execForPath: execHostForWorktreePath,
  remoteBasePath(repoKey) {
    return getRemoteRepoConfig(repoKey)?.basePath ?? null
  },
}

/** The git working dir + ExecHost a project key resolves to. */
interface ExecCtx {
  readonly exec: ExecHost
  /** Directory git runs in: the local repo path, or the remote basePath. */
  readonly dir: string
  readonly remote: boolean
}

export class GitWorktreeManager implements WorktreeManager {
  constructor(private readonly execDeps: WorktreeExecDeps = defaultExecDeps) {}

  /** Resolve the ExecHost + git working dir for a project key. */
  private ctxFor(repoKey: string): ExecCtx {
    const basePath = this.execDeps.remoteBasePath(repoKey)
    return basePath
      ? { exec: this.execDeps.execForRepo(repoKey), dir: basePath, remote: true }
      : { exec: this.execDeps.execForRepo(repoKey), dir: repoKey, remote: false }
  }

  /**
   * Run `git <args>` through `exec`, preserving git.ts's throw-on-nonzero /
   * `allowFail` contract so callers behave identically local or remote.
   *
   * ASYNC: this is the daemon's worktree hot path — a `git worktree add` on
   * a big repo is a minutes-long checkout, and a remote call is an ssh
   * round-trip. Awaiting the host's async `run` keeps the daemon's event
   * loop serving RPCs/pushes while git works.
   */
  private async runGit(exec: ExecHost, args: readonly string[], opts: GitRunOpts): Promise<GitRunResult> {
    if (!opts.cwd) {
      throw new Error("runGit(): cwd is required; refusing to inherit from process.cwd()")
    }
    const r = await exec.run(["git", ...args], { cwd: opts.cwd, env: opts.env })
    const result: GitRunResult = { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
    if (result.exitCode !== 0 && !opts.allowFail) {
      throw new GitCommandError(args, opts.cwd, result)
    }
    return result
  }
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
    const ctx = this.ctxFor(repo)
    requireAbsolute("repo", ctx.dir)
    requireAbsolute("path", worktreePath)
    if (!branch) throw new Error("create(): branch must be a non-empty string")

    // Idempotent fast-path: already a worktree here, on the right branch.
    if (await ctx.exec.exists(worktreePath)) {
      const existing = await this.tryDescribe(ctx, worktreePath)
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

    // Make sure the parent dir exists (`~/.kobe/worktrees/...` may be the
    // first time we write into the repo).
    await ctx.exec.mkdirp(path.dirname(worktreePath))

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
    const branchExists = await this.branchExists(ctx, branch)
    const args = branchExists
      ? ["worktree", "add", worktreePath, branch]
      : baseRef
        ? ["worktree", "add", "-b", branch, worktreePath, baseRef]
        : ["worktree", "add", "-b", branch, worktreePath]

    await this.runGit(ctx.exec, args, { cwd: ctx.dir })

    // Sanity-check the result so any failure surfaces here, not at the
    // first downstream `currentBranch()` call.
    const info = await this.tryDescribe(ctx, worktreePath)
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
   * `slug` is the directory basename — allocated by the orchestrator's
   * {@link SlugAllocator}. Under the slug scheme this is an animal name (e.g.
   * `panda`) or version-suffixed (`panda-v2`); before it, this was the
   * task's ULID. The manager doesn't care which — it just joins.
   *
   * `baseRef` (optional): forwarded to {@link create} so the new branch
   * can be rooted at an explicit ref instead of the repo's current HEAD.
   * The new-task dialog passes this through when the user chose a
   * non-default base branch.
   */
  async createForTask(args: {
    repo: string
    slug: string
    branch: string
    baseRef?: string
  }): Promise<WorktreeInfo> {
    // A remote project's worktree lives on the remote under its basePath, not
    // under the local `~/.kobe/worktrees` root.
    const basePath = this.execDeps.remoteBasePath(args.repo)
    const target = basePath ? remoteWorktreePathFor(basePath, args.slug) : worktreePathFor(args.repo, args.slug)
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
    const exec = this.execDeps.execForPath(worktreePath)
    const force = opts?.force === true

    if (!(await exec.exists(worktreePath))) {
      // Best-effort metadata prune — the directory may be gone but a
      // stale entry can survive in `.git/worktrees/`. `git worktree
      // remove` will refuse, so we use prune.
      const repo = await this.findRepoFor(exec, worktreePath)
      if (repo) await this.runGit(exec, ["worktree", "prune"], { cwd: repo, allowFail: true })
      return
    }

    // Resolve the owning repo via `rev-parse --git-common-dir` from
    // inside the worktree itself. This is the only reliable way to get
    // back to the main repo when the caller hands us only the path.
    const repo = await this.findRepoFor(exec, worktreePath)
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
    await this.runGit(exec, args, { cwd: repo })

    // Defensive prune — cleans up `.git/worktrees/<name>/` if the
    // remove left it behind (rare, but documented in vibe-kanban).
    await this.runGit(exec, ["worktree", "prune"], { cwd: repo, allowFail: true })
  }

  /**
   * List kobe-managed worktrees under `repo`.
   *
   * Parses `git worktree list --porcelain` and filters to entries
   * whose path lives inside a kobe-managed root. Worktrees the user
   * created elsewhere are invisible to kobe — we don't enumerate the
   * whole world.
   */
  async list(repo: string): Promise<readonly WorktreeInfo[]> {
    const ctx = this.ctxFor(repo)
    requireAbsolute("repo", ctx.dir)
    const out = await this.runGit(ctx.exec, ["worktree", "list", "--porcelain"], { cwd: ctx.dir })
    const all = parsePorcelain(out.stdout)

    const infos: WorktreeInfo[] = []
    for (const entry of all) {
      if (!entry.path) continue
      // Remote: kobe-managed = under <basePath>/.kobe/worktrees. Local: the
      // usual `~/.kobe/worktrees/<repo-key>` + legacy roots.
      const callerRoot = ctx.remote
        ? remoteManagedRootForPath(ctx.dir, entry.path)
        : managedWorktreeRootForPath(repo, entry.path)
      if (!callerRoot) continue
      // Detached / bare entries don't have a branch we care about.
      if (!entry.branch || entry.detached) continue
      // Re-root paths into the caller's form. Git on macOS reports
      // `/private/var/...` but the caller passed in `/var/...`; we hand
      // back paths that satisfy `path.startsWith(callerRoot)` so callers
      // can use string ops without surprise. Legacy paths stay under the
      // legacy root instead of being rewritten to the primary root.
      const canonRoot = canonicalize(callerRoot)
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
   * List ALL git worktrees registered on `repo` — including ones the
   * user created outside kobe-managed roots. Unlike
   * {@link list}, this does NOT filter to the kobe convention root; it's
   * the discovery source for "adopt an existing worktree as a task".
   *
   * Excludes the repo's main checkout (that's the main task, not an
   * adoptable worktree) and detached/bare entries (no branch to track).
   * Paths are returned as git reports them (absolute; on macOS that may
   * be the `/private/...` realpath) — valid as a worktree `cwd` and
   * compared canonically by callers, so no re-rooting is needed here.
   */
  async listAll(repo: string): Promise<readonly AdoptableWorktree[]> {
    const ctx = this.ctxFor(repo)
    requireAbsolute("repo", ctx.dir)
    const out = await this.runGit(ctx.exec, ["worktree", "list", "--porcelain"], { cwd: ctx.dir })
    const all = parsePorcelain(out.stdout)
    const canonRepo = ctx.remote ? ctx.dir : canonicalize(ctx.dir)

    const infos: AdoptableWorktree[] = []
    for (const entry of all) {
      if (!entry.path) continue
      if (entry.bare) continue
      // Detached entries have no branch to map to a task's branch.
      if (!entry.branch || entry.detached) continue
      // Skip the main checkout — it's the repo root (the main task).
      if ((ctx.remote ? entry.path : canonicalize(entry.path)) === canonRepo) continue
      const dirty = await this.isDirty(entry.path)
      infos.push({
        path: entry.path,
        branch: entry.branch,
        head: entry.head ?? "",
        dirty,
        kobeManaged: ctx.remote
          ? remoteManagedRootForPath(ctx.dir, entry.path) !== null
          : isKobeManagedPath(repo, entry.path),
        lastActivityMs: await this.lastActivityMs(ctx.exec, entry.path),
      })
    }
    // Most recently active first.
    infos.sort((a, b) => b.lastActivityMs - a.lastActivityMs)
    return infos
  }

  /**
   * Last-activity time of a worktree in epoch ms — the HEAD commit's
   * committer time, falling back to the directory's mtime when the log
   * read fails (e.g. an unborn branch). Best-effort: returns 0 on total
   * failure so sorting still works. Used to order the adopt list.
   */
  private async lastActivityMs(exec: ExecHost, worktreePath: string): Promise<number> {
    try {
      const out = await this.runGit(exec, ["log", "-1", "--format=%ct"], { cwd: worktreePath })
      const secs = Number.parseInt(out.stdout.trim(), 10)
      if (Number.isFinite(secs) && secs > 0) return secs * 1000
    } catch {
      // no commits yet / not readable — fall through to mtime
    }
    // mtime fallback is a local-only convenience; on a remote the git-log
    // path above is the source of truth and a miss simply sorts as 0.
    if (!exec.isRemote) {
      try {
        return fs.statSync(worktreePath).mtimeMs
      } catch {
        // unreadable — fall through to 0
      }
    }
    return 0
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
    const exec = this.execDeps.execForPath(worktreePath)
    const out = await this.runGit(exec, ["status", "--porcelain"], { cwd: worktreePath })
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
    const exec = this.execDeps.execForPath(worktreePath)
    const out = await this.runGit(exec, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath })
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
    const exec = this.execDeps.execForPath(worktreePath)
    const repo = await this.findRepoFor(exec, worktreePath)
    if (!repo) throw new Error(`renameBranch(): ${worktreePath} is not a git worktree`)
    await this.runGit(exec, ["branch", "-m", from, to], { cwd: repo })
  }

  // ---------- internals ----------

  /**
   * Read a single worktree's info if it's actually registered with the
   * repo at `repo`. Returns null if `path` exists on disk but isn't a
   * git worktree. This is how `create()`'s idempotency check
   * distinguishes "already done" from "stale debris".
   */
  private async tryDescribe(ctx: ExecCtx, worktreePath: string): Promise<WorktreeInfo | null> {
    const out = await this.runGit(ctx.exec, ["worktree", "list", "--porcelain"], { cwd: ctx.dir })
    const entries = parsePorcelain(out.stdout)
    // Remote paths can't be realpath'd locally; compare them verbatim.
    const norm = (p: string) => (ctx.remote ? p : canonicalize(p))
    const target = norm(worktreePath)
    const match = entries.find((e) => e.path && norm(e.path) === target)
    if (!match || !match.path || !match.branch || match.detached) return null
    return {
      // Return the caller's requested path verbatim — they passed in
      // `~/.kobe/worktrees/<repo-key>/<id>` (or a persisted legacy path) and may compare against that
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
  private async branchExists(ctx: ExecCtx, branch: string): Promise<boolean> {
    const ref = `refs/heads/${branch}`
    const out = await this.runGit(ctx.exec, ["show-ref", "--verify", "--quiet", ref], {
      cwd: ctx.dir,
      allowFail: true,
    })
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
  private async findRepoFor(exec: ExecHost, worktreePath: string): Promise<string | null> {
    try {
      const out = await this.runGit(exec, ["rev-parse", "--git-common-dir"], { cwd: worktreePath, allowFail: true })
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

/**
 * Remote analogue of {@link managedWorktreeRootForPath}: is `candidate` under
 * `<basePath>/.kobe/worktrees`? Pure string compare on POSIX remote paths (no
 * local realpath possible). Returns the remote root when matched, else null.
 */
function remoteManagedRootForPath(basePath: string, candidate: string): string | null {
  const root = `${basePath.replace(/\/+$/, "")}/.kobe/worktrees`
  return candidate === root || candidate.startsWith(`${root}/`) ? root : null
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
