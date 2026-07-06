import { statSync } from "node:fs"
import { execHostForWorktreePath } from "@/exec/resolve"
import { GitWorktreeManager } from "@/orchestrator/worktree/manager"
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

async function listLocalProjects(): Promise<WorktreeProject[]> {
  const localRepos = getSavedRepos().filter((repo) => !getRemoteRepoConfig(repo))
  return Promise.all(
    localRepos.map(async (repo) => {
      const worktrees = await worktreeManager.listAll(repo)
      const rows = await Promise.all(
        worktrees.map(
          async (wt): Promise<WorktreeAuditRow> => ({
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
    async handle() {
      return { projects: await listLocalProjects() }
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
