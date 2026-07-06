/**
 * `/api/worktrees` — cross-project worktree audit for the standalone
 * worktree-management page.
 *
 * Deliberately NOT a daemon RPC (`handlers.ts`/`protocol.ts`): everything it
 * needs — `GitWorktreeManager`, `getSavedRepos` — is already a public,
 * orchestrator-independent primitive, so this route composes them directly
 * instead of adding to the already-oversized handler registry. Task linkage
 * ("is this worktree backing an active task?") is left to the caller, which
 * already holds the task list client-side.
 *
 * Local projects only for v1 — a remote (`ssh://…`) project's worktrees would
 * need `git ls-remote`/`fs.stat` run over its `ExecHost` instead of directly,
 * a real follow-up rather than bundled here.
 */

import { statSync } from "node:fs"
import { execHostForWorktreePath } from "@/exec/resolve"
import { GitWorktreeManager } from "@/orchestrator/worktree/manager"
import { getRemoteRepoConfig, getSavedRepos } from "@/state/repos"
import type { AdoptableWorktree } from "@/types/worktree"

const ROUTE = "/api/worktrees"
const REMOTE_CHECK_TIMEOUT_MS = 4_000

const manager = new GitWorktreeManager()

export interface WorktreeRow extends AdoptableWorktree {
  readonly repo: string
  /** Worktree directory's creation time (epoch ms) — distinct from the
   *  existing `lastActivityMs` (last-commit time). 0 when unreadable. */
  readonly createdAtMs: number
  /** Whether `branch` exists on `origin`. `null` = no origin / unreachable /
   *  timed out — rendered as "unknown", never a delete-blocker. */
  readonly branchOnRemote: boolean | null
}

function createdAtMs(worktreePath: string): number {
  try {
    const stat = statSync(worktreePath)
    return stat.birthtimeMs || stat.mtimeMs
  } catch {
    return 0
  }
}

async function branchOnRemote(worktreePath: string, branch: string): Promise<boolean | null> {
  try {
    const exec = execHostForWorktreePath(worktreePath)
    const out = await exec.run(["git", "ls-remote", "--exit-code", "--heads", "origin", branch], {
      cwd: worktreePath,
      signal: AbortSignal.timeout(REMOTE_CHECK_TIMEOUT_MS),
    })
    if (out.exitCode === 0) return true
    if (out.exitCode === 2) return false
    return null
  } catch {
    return null
  }
}

async function listProjects(): Promise<{ repo: string; worktrees: WorktreeRow[] }[]> {
  const localRepos = getSavedRepos().filter((repo) => !getRemoteRepoConfig(repo))
  return Promise.all(
    localRepos.map(async (repo) => {
      const worktrees = await manager.listAll(repo)
      const rows = await Promise.all(
        worktrees.map(
          async (wt): Promise<WorktreeRow> => ({
            ...wt,
            repo,
            createdAtMs: createdAtMs(wt.path),
            branchOnRemote: await branchOnRemote(wt.path, wt.branch),
          }),
        ),
      )
      return { repo, worktrees: rows }
    }),
  )
}

async function handleGet(): Promise<Response> {
  try {
    return Response.json({ projects: await listProjects() })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

async function handleDelete(req: Request): Promise<Response> {
  let body: { path?: unknown; force?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 })
  }
  if (typeof body.path !== "string" || !body.path) {
    return Response.json({ error: "missing path" }, { status: 400 })
  }
  try {
    await manager.remove(body.path, { force: body.force === true })
    return Response.json({ removed: true })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}

export async function handleWorktreesRequest(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null
  if (req.method === "GET") return handleGet()
  if (req.method === "DELETE") return handleDelete(req)
  return Response.json({ error: "method not allowed" }, { status: 405 })
}
