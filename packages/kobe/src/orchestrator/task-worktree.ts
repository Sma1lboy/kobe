import { resolveRepoRoot, sameRepoToplevel } from "../state/repos"
import type { OrchestratorEvent } from "../types/engine"
import type { Task, TaskId } from "../types/task"
import { worktreeSlug } from "../types/task"
import type { TaskIndexStore } from "./index/store"
import type { MetadataSuggester } from "./metadata-suggester"
import { deriveTitleFromPrompt } from "./title"
import type { GitWorktreeManager } from "./worktree/manager"
import { SlugAllocator } from "./worktree/slug-allocator"

/**
 * Boil a `git worktree add` failure down to a one-line, user-actionable
 * message. The raw `GitCommandError` text from `src/orchestrator/worktree/git.ts`
 * is dense; we strip it here so the chat banner the user sees is short
 * enough to read at a glance.
 */
export function summarizeWorktreeError(raw: string, repo: string, baseRef: string | null): string {
  const m = raw.toLowerCase()
  if (m.includes("invalid reference") || m.includes("unknown revision") || m.includes("not a valid object name")) {
    const ref = baseRef ?? "(none)"
    return `could not create worktree: base ref '${ref}' does not exist in ${repo}`
  }
  if (m.includes("not a git repository") || m.includes("not in a git directory")) {
    return `could not create worktree: ${repo} is not a git repository`
  }
  if (m.includes("permission denied") || m.includes("eacces")) {
    return `could not create worktree: permission denied writing into ${repo}/.claude/worktrees/`
  }
  if (m.includes("already exists") || m.includes("refusing to hijack") || m.includes("is on branch")) {
    return `could not create worktree: a stale worktree already exists for this task (try removing it under ${repo}/.claude/worktrees/)`
  }
  if (m.includes("enoent") || m.includes("does not exist")) {
    return `could not create worktree: ${repo} does not exist`
  }
  const fatal = raw.match(/fatal:\s*([^\n]+)/i)
  if (fatal) return `could not create worktree: ${fatal[1]?.trim() ?? raw}`
  return `could not create worktree: ${raw.trim()}`
}

export class TaskWorktreeCoordinator {
  private readonly pendingWorktreeOpts = new Map<TaskId, { branch?: string; baseRef?: string }>()
  private readonly ensureWorktreeLatches = new Map<TaskId, Promise<Task>>()
  private readonly slugAllocator: SlugAllocator

  constructor(
    private readonly deps: {
      readonly store: TaskIndexStore
      readonly worktrees: GitWorktreeManager
      readonly metadataSuggester: MetadataSuggester
      readonly dispatchEvent: (taskId: TaskId, tabId: string, ev: OrchestratorEvent) => void
    },
  ) {
    this.slugAllocator = new SlugAllocator((repo) =>
      this.deps.store
        .list()
        .filter((t) => t.repo === repo && !t.archived)
        .map((t) => worktreeSlug(t))
        .filter((s) => s.length > 0),
    )
  }

  registerPendingWorktreeOpts(taskId: TaskId, opts: { branch?: string; baseRef?: string }): void {
    this.pendingWorktreeOpts.set(taskId, opts)
  }

  async ensureMainTask(repo: string): Promise<Task> {
    if (!repo) throw new Error("ensureMainTask: repo is required")
    const normalized = resolveRepoRoot(repo)
    const all = this.deps.store.list()
    const candidates = all.filter((t) => t.kind === "main" && sameRepoToplevel(t.repo, normalized))
    const winner = candidates.find((t) => t.repo === normalized) ?? candidates[0]
    if (winner) {
      for (const dup of candidates) {
        if (dup.id !== winner.id) {
          try {
            await this.deps.store.remove(dup.id)
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`[kobe orchestrator] ensureMainTask: failed to remove duplicate ${dup.id}:`, err)
          }
        }
      }
      let existing = winner
      if (existing.repo !== normalized || existing.worktreePath !== normalized) {
        existing = await this.deps.store.update(existing.id, {
          repo: normalized,
          worktreePath: normalized,
          title: normalized.split("/").filter(Boolean).pop() ?? normalized,
        })
      }
      if (existing.archived) {
        return await this.deps.store.update(existing.id, { archived: false })
      }
      return existing
    }
    const basename = normalized.split("/").filter(Boolean).pop() ?? normalized
    return await this.deps.store.create({
      title: basename,
      repo: normalized,
      branch: "",
      worktreePath: normalized,
      sessionId: null,
      status: "backlog",
      archived: false,
      kind: "main",
    })
  }

  async ensureWorktree(task: Task): Promise<Task> {
    if (task.worktreePath) return task
    const inflight = this.ensureWorktreeLatches.get(task.id)
    if (inflight) {
      await inflight
      const fresh = this.deps.store.get(task.id)
      if (!fresh) throw new Error(`task not found after worktree allocation: ${task.id}`)
      return fresh
    }
    const latch = this.doEnsureWorktree(task)
    this.ensureWorktreeLatches.set(task.id, latch)
    try {
      return await latch
    } finally {
      this.ensureWorktreeLatches.delete(task.id)
    }
  }

  private async doEnsureWorktree(task: Task): Promise<Task> {
    const opts = this.pendingWorktreeOpts.get(task.id)
    const branch = opts?.branch ?? `kobe/tmp-${task.id.slice(-8).toLowerCase()}`
    const baseRef = opts?.baseRef
    const slug = await this.slugAllocator.allocate(task.repo)
    let info: Awaited<ReturnType<GitWorktreeManager["createForTask"]>>
    try {
      info = await this.deps.worktrees.createForTask({
        repo: task.repo,
        slug,
        branch,
        baseRef,
      })
    } catch (err) {
      this.slugAllocator.cancel(task.repo, slug)
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(summarizeWorktreeError(message, task.repo, baseRef ?? null), { cause: err })
    }
    try {
      this.pendingWorktreeOpts.delete(task.id)
      const updated = await this.deps.store.update(task.id, {
        branch: info.branch,
        worktreePath: info.path,
      })
      this.slugAllocator.commit(task.repo, slug)
      return updated
    } catch (err) {
      this.slugAllocator.cancel(task.repo, slug)
      throw err
    }
  }

  async maybeRenameTempBranch(taskId: TaskId, tabId: string, prompt: string | undefined): Promise<void> {
    if (!prompt || prompt.trim().length === 0) return
    const task = this.deps.store.get(taskId)
    if (!task || !task.worktreePath) return
    if (!task.branch.startsWith("kobe/tmp-")) return

    this.deps.dispatchEvent(taskId, tabId, {
      type: "system.info",
      text: "branch: choosing a name...",
    })

    const slug = await this.deps.metadataSuggester.suggestBranchSlug(prompt)
    if (!slug) return

    const fresh = this.deps.store.get(taskId)
    if (!fresh || !fresh.worktreePath) return
    if (fresh.branch !== task.branch) return

    const newBranch = `kobe/${slug}-${taskId.slice(-4).toLowerCase()}`
    if (newBranch === fresh.branch) return

    try {
      await this.deps.worktrees.renameBranch(fresh.worktreePath, fresh.branch, newBranch)
      await this.deps.store.update(taskId, { branch: newBranch })
      this.deps.dispatchEvent(taskId, tabId, {
        type: "system.info",
        text: `branch: renamed to ${newBranch}`,
      })
    } catch {
      /* leave the temp name; user can rename via `r` in sidebar */
    }
  }

  async maybeUpgradeTitle(taskId: TaskId, prompt: string): Promise<void> {
    if (!prompt || prompt.trim().length === 0) return
    const task = this.deps.store.get(taskId)
    if (!task) return
    const derived = deriveTitleFromPrompt(prompt)
    if (!derived) return
    if (task.title !== derived) return

    const suggested = await this.deps.metadataSuggester.suggestTitle(prompt)
    if (!suggested) return
    if (suggested === derived) return

    const fresh = this.deps.store.get(taskId)
    if (!fresh) return
    if (fresh.title !== derived) return

    await this.deps.store.update(taskId, { title: suggested })
  }
}
