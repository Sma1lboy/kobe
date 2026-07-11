/**
 * The worktree LISTING operations, split out of `manager.ts` (file-size cap).
 *
 * `listManaged` / `listAllAdoptable` / `adoptablePaths` are the porcelain-parse
 * + filter + concurrent-probe logic behind `GitWorktreeManager.list` /
 * `.listAll` / `.listAdoptablePaths`. They're free functions taking a small
 * {@link ListDeps} (the ctx + the git/probe primitives the manager already
 * owns) so the class methods stay thin delegators — no behaviour change.
 */

import path from "node:path"
import type { AdoptableWorktree, WorktreeInfo } from "../../types/worktree.ts"
import { PROBE_CONCURRENCY, mapWithLimit } from "./concurrency.ts"
import type { ExecCtx } from "./exec-deps.ts"
import {
  canonicalize,
  isKobeManagedPath,
  managedWorktreeRootForPath,
  remoteManagedRootForPath,
  requireAbsolute,
} from "./paths.ts"
import { parseWorktreeListPorcelain } from "./worktree-list.ts"

/** The manager primitives the listing functions borrow. */
export interface ListDeps {
  ctxFor(repoKey: string): ExecCtx
  runGitStdout(ctx: ExecCtx, args: readonly string[]): Promise<string>
  isDirty(worktreePath: string): Promise<boolean>
  lastActivityMs(ctx: ExecCtx, worktreePath: string): Promise<number>
}

/** kobe-managed worktrees under `repo` — see `GitWorktreeManager.list`. */
export async function listManaged(deps: ListDeps, repo: string): Promise<readonly WorktreeInfo[]> {
  const ctx = deps.ctxFor(repo)
  requireAbsolute("repo", ctx.dir)
  const all = parseWorktreeListPorcelain(await deps.runGitStdout(ctx, ["worktree", "list", "--porcelain"]))

  // Filter + re-root synchronously first, then probe every survivor's dirty
  // state concurrently (bounded) — the probes are the slow part (a git status /
  // ssh round-trip each), so they must not run one-at-a-time.
  const kept: {
    readonly callerPath: string
    readonly probePath: string
    readonly branch: string
    readonly head: string
  }[] = []
  for (const entry of all) {
    if (!entry.path) continue
    // Remote: kobe-managed = under <basePath>/.kobe/worktrees. Local: the usual
    // `~/.kobe/worktrees/<repo-key>` + legacy roots.
    const callerRoot = ctx.remote
      ? remoteManagedRootForPath(ctx.dir, entry.path)
      : managedWorktreeRootForPath(repo, entry.path)
    if (!callerRoot) continue
    // Detached / bare entries don't have a branch we care about.
    if (!entry.branch || entry.detached) continue
    // Re-root paths into the caller's form. Git on macOS reports
    // `/private/var/...` but the caller passed in `/var/...`; we hand back paths
    // that satisfy `path.startsWith(callerRoot)` so callers can use string ops
    // without surprise. Legacy paths stay under the legacy root instead of being
    // rewritten to the primary root.
    const rel = path.relative(canonicalize(callerRoot), canonicalize(entry.path))
    kept.push({
      callerPath: path.join(callerRoot, rel),
      probePath: entry.path,
      branch: entry.branch,
      head: entry.head ?? "",
    })
  }
  return mapWithLimit(kept, PROBE_CONCURRENCY, async (e) => ({
    path: e.callerPath,
    branch: e.branch,
    head: e.head,
    dirty: await deps.isDirty(e.probePath),
  }))
}

/** ALL adoptable worktrees under `repo` (probed) — see `GitWorktreeManager.listAll`. */
export async function listAllAdoptable(deps: ListDeps, repo: string): Promise<readonly AdoptableWorktree[]> {
  const ctx = deps.ctxFor(repo)
  const adoptable = await adoptablePaths(deps, ctx)
  // Probe dirty + last-activity for every survivor concurrently (bounded) — two
  // git spawns / ssh round-trips each, the slow part of this call.
  const infos = await mapWithLimit(adoptable, PROBE_CONCURRENCY, async (entry) => {
    const [dirty, lastActivityMs] = await Promise.all([deps.isDirty(entry.path), deps.lastActivityMs(ctx, entry.path)])
    return {
      path: entry.path,
      branch: entry.branch,
      head: entry.head,
      dirty,
      kobeManaged: ctx.remote
        ? remoteManagedRootForPath(ctx.dir, entry.path) !== null
        : isKobeManagedPath(repo, entry.path),
      lastActivityMs,
    }
  })
  // Most recently active first.
  infos.sort((a, b) => b.lastActivityMs - a.lastActivityMs)
  return infos
}

/**
 * The bare/detached/main-checkout filter shared by {@link listAllAdoptable} and
 * `GitWorktreeManager.listAdoptablePaths`: keep only entries that are adoption
 * candidates (a real, non-bare, branch-checked-out worktree that isn't the
 * repo's own main checkout). No per-worktree probes — the cheap part callers
 * layer probes onto (or, for a path match, skip entirely).
 */
export async function adoptablePaths(
  deps: ListDeps,
  ctx: ExecCtx,
): Promise<{ readonly path: string; readonly branch: string; readonly head: string }[]> {
  requireAbsolute("repo", ctx.dir)
  const all = parseWorktreeListPorcelain(await deps.runGitStdout(ctx, ["worktree", "list", "--porcelain"]))
  const canonRepo = ctx.remote ? ctx.dir : canonicalize(ctx.dir)
  const kept: { readonly path: string; readonly branch: string; readonly head: string }[] = []
  for (const entry of all) {
    if (!entry.path) continue
    if (entry.bare) continue
    // Detached entries have no branch to map to a task's branch.
    if (!entry.branch || entry.detached) continue
    // Skip the main checkout — it's the repo root (the main task).
    if ((ctx.remote ? entry.path : canonicalize(entry.path)) === canonRepo) continue
    kept.push({ path: entry.path, branch: entry.branch, head: entry.head ?? "" })
  }
  return kept
}
