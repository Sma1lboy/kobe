/**
 * `worktree.*` daemon RPC handlers.
 *
 * The first 4 entries (`discoverAdoptable`/`adopt`/`reconcile`/
 * `archiveRemoved`) are split out of `handlers.ts` (which was over the
 * repo's 500-line file-size cap) purely mechanically — same behavior,
 * moved verbatim.
 *
 * `list`/`remove` are NEW — the standalone worktree-management TUI page
 * (`tui/component/worktrees-page.tsx`). Unlike the other four, they don't
 * need `ctx.orch`: `GitWorktreeManager` and `getSavedRepos()` are already
 * public, orchestrator-independent primitives, so these compose them
 * directly instead of routing through the Orchestrator. Local projects
 * only for v1 — a remote (`ssh://…`) project's worktrees would need
 * `git ls-remote`/`fs.stat` run over its `ExecHost` instead of directly, a
 * real follow-up rather than bundled here.
 */

import { statSync } from "node:fs"
import { execHostForWorktreePath } from "@/exec/resolve"
import { GitWorktreeManager } from "@/orchestrator/worktree/manager"
import { type PrState, judgeWorktree, parseGhPrList } from "@/orchestrator/worktree/staleness"
import { getRemoteRepoConfig, getSavedRepos } from "@/state/repos"
import type { WorktreeAuditRow, WorktreeProject } from "@/types/worktree"
import { logDaemonError } from "./crash-log.ts"
import { matchRepoByCwd, matchTaskByWorktreePath } from "./cwd-task.ts"
import { optionalString, optionalVendor, requireString } from "./handler-validators.ts"
import type { DaemonRequestHandler } from "./handlers.ts"
import { serializeTask } from "./protocol.ts"

const REMOTE_CHECK_TIMEOUT_MS = 4_000

const worktreeManager = new GitWorktreeManager()

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

/** `origin/<default>` ref for ahead-count checks; null when unresolvable. */
async function defaultBranchRef(repo: string): Promise<string | null> {
  const exec = execHostForWorktreePath(repo)
  try {
    const out = await exec.run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: repo,
      signal: AbortSignal.timeout(REMOTE_CHECK_TIMEOUT_MS),
    })
    const ref = out.stdout.trim()
    if (out.exitCode === 0 && ref) return ref
  } catch {
    /* fall through to the guesses */
  }
  // origin/HEAD is often unset on old clones — try the two conventional names.
  for (const guess of ["origin/main", "origin/master"]) {
    try {
      const out = await exec.run(["git", "rev-parse", "--verify", "--quiet", guess], {
        cwd: repo,
        signal: AbortSignal.timeout(REMOTE_CHECK_TIMEOUT_MS),
      })
      if (out.exitCode === 0) return guess
    } catch {
      /* keep guessing */
    }
  }
  return null
}

/**
 * Branch → PR state for the whole repo in ONE `gh pr list` call (per-branch
 * `gh pr view`s would be N network round-trips). GitHub-only by origin-URL
 * check; null (no data, verdicts fall back to git-only signals) on any
 * failure — `gh` missing, unauthenticated, offline, non-GitHub forge.
 */
async function prStatesForRepo(repo: string): Promise<ReadonlyMap<string, PrState> | null> {
  const exec = execHostForWorktreePath(repo)
  try {
    const origin = await exec.run(["git", "remote", "get-url", "origin"], {
      cwd: repo,
      signal: AbortSignal.timeout(REMOTE_CHECK_TIMEOUT_MS),
    })
    if (origin.exitCode !== 0 || !origin.stdout.includes("github.com")) return null
    const out = await exec.run(
      ["gh", "pr", "list", "--state", "all", "--limit", "200", "--json", "headRefName,state"],
      {
        cwd: repo,
        signal: AbortSignal.timeout(REMOTE_CHECK_TIMEOUT_MS),
      },
    )
    if (out.exitCode !== 0) return null
    return parseGhPrList(out.stdout)
  } catch {
    return null
  }
}

/** `git rev-list --count <defaultRef>..HEAD` — 0 means main already has everything. */
async function aheadOfDefault(worktreePath: string, defaultRef: string | null): Promise<number | null> {
  if (!defaultRef) return null
  try {
    const exec = execHostForWorktreePath(worktreePath)
    const out = await exec.run(["git", "rev-list", "--count", `${defaultRef}..HEAD`], {
      cwd: worktreePath,
      signal: AbortSignal.timeout(REMOTE_CHECK_TIMEOUT_MS),
    })
    if (out.exitCode !== 0) return null
    const n = Number.parseInt(out.stdout.trim(), 10)
    return Number.isNaN(n) ? null : n
  } catch {
    return null
  }
}

/**
 * `network: false` is the page's instant first paint — every forge/network
 * lookup (ls-remote per worktree, `gh pr list` per repo) is skipped and its
 * signal reads unknown; verdicts still fire from the local git signals
 * (dirty / ahead-of-default / age). The page re-requests with network on.
 */
async function listLocalProjects(network: boolean): Promise<WorktreeProject[]> {
  const localRepos = getSavedRepos().filter((repo) => !getRemoteRepoConfig(repo))
  const now = Date.now()
  return Promise.all(
    localRepos.map(async (repo) => {
      // Repo-level signals once, not per worktree: the PR map and the
      // default-branch ref are shared by every row below.
      const [worktrees, prStates, defaultRef] = await Promise.all([
        worktreeManager.listAll(repo),
        network ? prStatesForRepo(repo) : null,
        defaultBranchRef(repo),
      ])
      const rows = await Promise.all(
        worktrees.map(async (wt): Promise<WorktreeAuditRow> => {
          const [remote, ahead] = await Promise.all([
            network ? branchOnRemote(wt.path, wt.branch) : null,
            aheadOfDefault(wt.path, defaultRef),
          ])
          const judgement = judgeWorktree(
            {
              dirty: wt.dirty,
              prState: prStates?.get(wt.branch) ?? null,
              aheadOfDefault: ahead,
              lastActivityMs: wt.lastActivityMs,
            },
            now,
          )
          return {
            ...wt,
            repo,
            createdAtMs: createdAtMs(wt.path),
            branchOnRemote: remote,
            verdict: judgement.verdict,
            verdictReason: judgement.reason,
          }
        }),
      )
      return { repo, worktrees: rows }
    }),
  )
}

export const WORKTREE_HANDLERS: readonly DaemonRequestHandler[] = [
  {
    name: "worktree.discoverAdoptable",
    async handle(payload, ctx) {
      const repo = requireString(payload, "repo")
      const worktrees = await ctx.orch.discoverAdoptableWorktrees(repo)
      return { worktrees }
    },
  },
  {
    name: "worktree.adopt",
    async handle(payload, ctx) {
      const task = await ctx.orch.adoptWorktree({
        repo: requireString(payload, "repo"),
        worktreePath: requireString(payload, "worktreePath"),
        branch: optionalString(payload, "branch"),
        vendor: optionalVendor(payload, "vendor"),
        title: optionalString(payload, "title"),
        ifExists: optionalString(payload, "ifExists") === "return" ? "return" : "error",
      })
      return { task: serializeTask(task) }
    },
  },
  {
    name: "worktree.reconcile",
    async handle(payload, ctx) {
      // A `kobe hook worktree-created` (global PostToolUse) reporting that a
      // `git worktree add` just ran in `cwd`, creating `worktreePath`. Adopt
      // it the MOMENT it's created — no engine session needed (the
      // creation-time complement to the `session-start` auto-adopt in
      // `engine.reportEvent` below). Bounded to repos kobe already tracks
      // (so a stray worktree in an untracked repo is ignored); `adoptWorktree`
      // is idempotent + git-validated, so a re-fired hook or a bogus path is a
      // harmless no-op (the path just fails validation → caught → dropped).
      const cwd = requireString(payload, "cwd")
      const worktreePath = requireString(payload, "worktreePath")
      const repo = matchRepoByCwd(ctx.orch.listTasks(), cwd) ?? matchRepoByCwd(ctx.orch.listTasks(), worktreePath)
      if (!repo) return { adopted: false }
      try {
        const task = await ctx.orch.adoptWorktree({ repo, worktreePath, ifExists: "return" })
        return { adopted: true, taskId: task.id }
      } catch (err) {
        logDaemonError("worktree-created", err)
        return { adopted: false }
      }
    },
  },
  {
    name: "worktree.archiveRemoved",
    async handle(payload, ctx) {
      // A `kobe hook worktree-created` (global PostToolUse) reporting that a
      // `git worktree remove <path>` just ran. Archive the task pinned to that
      // exact worktree — the symmetric complement to `worktree.reconcile`
      // (add a worktree → adopt a task; remove it → archive that task). We
      // ARCHIVE, never delete: the task's history/branch survive, it just
      // leaves the active board (and `setArchived` no-ops a `main` task, so a
      // repo root can't be archived this way). Exact-path match (not
      // longest-prefix) so removing an untracked worktree can't archive a
      // parent main task. Idempotent: an already-archived or unmatched path is
      // a harmless no-op.
      const worktreePath = requireString(payload, "worktreePath")
      const taskId = matchTaskByWorktreePath(ctx.orch.listTasks(), worktreePath)
      if (!taskId) return { archived: false }
      try {
        await ctx.orch.setArchived(taskId, true)
        return { archived: true, taskId }
      } catch (err) {
        logDaemonError("worktree-removed", err)
        return { archived: false }
      }
    },
  },
  {
    name: "worktree.list",
    async handle(payload) {
      return { projects: await listLocalProjects(payload.network !== false) }
    },
  },
  {
    name: "worktree.remove",
    async handle(payload) {
      const path = requireString(payload, "path")
      const force = payload.force === true
      await worktreeManager.remove(path, { force })
      return { removed: true }
    },
  },
]
