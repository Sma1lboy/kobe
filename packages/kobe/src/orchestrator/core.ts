import { realpathSync } from "node:fs"
import { basename, resolve } from "node:path"
import type { Accessor } from "solid-js"
import { createSignal } from "solid-js"
import { samePrStatus } from "../monitor/pr-status.ts"
import {
  getRemoteRepoConfig,
  getSavedRepos,
  isRemoteRepoKey,
  removeSavedRepo,
  resolveRepoRoot,
} from "../state/repos.ts"
import { resolvePreferredVendor } from "../state/vendor-prefs.ts"
import type { Task, TaskId, TaskPRStatus, TaskStatus, VendorId } from "../types/task.ts"
import { DEFAULT_TASK_VENDOR, toTaskId } from "../types/task.ts"
import type { AdoptableWorktree, WorktreeInfo } from "../types/worktree.ts"
import {
  CannotDeleteMainTaskError,
  DirtyWorktreeError,
  IllegalTransitionError,
  TaskNotFoundError,
  WorktreeRemoveFailedError,
} from "./errors.ts"
import type { TaskIndexStore, TaskIndexUnsubscribe } from "./index/store.ts"
import { autoBranch } from "./title.ts"
import type { GitWorktreeManager } from "./worktree/manager.ts"
import { worktreePathFor } from "./worktree/paths.ts"
import { SlugAllocator } from "./worktree/slug-allocator.ts"

function repoWorkingDir(repo: string): string {
  return getRemoteRepoConfig(repo)?.basePath ?? repo
}

export interface CreateTaskInput {
  readonly repo: string
  readonly title?: string
  readonly branch?: string
  readonly baseRef?: string
  readonly vendor?: VendorId
  readonly modelEffort?: string
}

export type Unsubscribe = () => void
export type TaskListListener = (snapshot: readonly Task[]) => void

export interface OrchestratorDeps {
  readonly store: TaskIndexStore
  readonly worktrees: GitWorktreeManager
}

export const PLACEHOLDER_TASK_TITLE = "(new task)"

export class Orchestrator {
  private readonly store: TaskIndexStore
  private readonly worktrees: GitWorktreeManager
  private readonly slugs: SlugAllocator
  private readonly tasksAcc: Accessor<Task[]>
  private readonly setTasks: (next: Task[]) => void
  private readonly activeTaskAcc: Accessor<string | null>
  private readonly setActiveTaskSig: (next: string | null) => void
  private readonly unsubscribeStore: TaskIndexUnsubscribe
  private readonly worktreeLocks = new Map<TaskId, Promise<string>>()
  private readonly mainTaskLocks = new Map<string, Promise<Task>>()

  constructor(deps: OrchestratorDeps) {
    this.store = deps.store
    this.worktrees = deps.worktrees
    this.slugs = new SlugAllocator((repo) =>
      this.store
        .list()
        .filter((t) => t.repo === repo && t.kind !== "main")
        .map((t) => {
          const slug = t.worktreePath.match(/([^/\\]+)[/\\]*$/)?.[1] ?? ""
          return slug
        })
        .filter((s) => s.length > 0),
    )
    const [tasks, setTasks] = createSignal<Task[]>(this.store.list())
    this.tasksAcc = tasks
    this.setTasks = (next) => setTasks(() => next)
    const [activeTask, setActiveTask] = createSignal<string | null>(null)
    this.activeTaskAcc = activeTask
    this.setActiveTaskSig = (next) => setActiveTask(() => next)
    this.unsubscribeStore = this.store.subscribe((snapshot) => {
      this.setTasks(snapshot.slice())
    })
  }

  async init(): Promise<void> {}

  activeTaskSignal(): Accessor<string | null> {
    return this.activeTaskAcc
  }

  async setActiveTask(id: TaskId | string | null): Promise<void> {
    const next = id === null ? null : String(id)
    this.setActiveTaskSig(next)
    if (next && this.store.get(next)) {
      await this.store.update(next, {})
    }
  }

  tasksSignal(): Accessor<Task[]> {
    return this.tasksAcc
  }

  subscribeTasks(listener: TaskListListener): Unsubscribe {
    return this.store.subscribe(listener)
  }

  dispose(): void {
    this.unsubscribeStore()
  }

  listTasks(): Task[] {
    return this.store.list()
  }

  getTask(id: TaskId | string): Task | undefined {
    return this.store.get(id)
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    if (!input.repo) throw new Error("createTask: repo is required")
    const title = (input.title ?? PLACEHOLDER_TASK_TITLE).trim() || PLACEHOLDER_TASK_TITLE
    const task = await this.store.create({
      repo: input.repo,
      title,
      branch: input.branch ?? "",
      worktreePath: "",
      status: "backlog",
      kind: "task",
      vendor: input.vendor ?? DEFAULT_TASK_VENDOR,
      ...(input.modelEffort ? { modelEffort: input.modelEffort } : {}),
    })
    if (input.baseRef) this.pendingBaseRefs.set(task.id, input.baseRef)
    return task
  }

  async ensureMainTask(repo: string): Promise<Task> {
    const { repo: normalizedRepo, key } = normalizeMainRepo(repo)
    const existing = this.store.list().find((t) => t.kind === "main" && normalizeMainRepo(t.repo).key === key)
    if (existing) return existing
    const inflight = this.mainTaskLocks.get(key)
    if (inflight) return inflight
    const promise = (async () => {
      const vendor = resolvePreferredVendor(normalizedRepo)
      const created = await this.store.create({
        repo: normalizedRepo,
        title: titleFromRepo(normalizedRepo),
        branch: "",
        worktreePath: repoWorkingDir(normalizedRepo),
        status: "backlog",
        kind: "main",
        vendor,
      })
      return created
    })()
    this.mainTaskLocks.set(key, promise)
    try {
      return await promise
    } finally {
      this.mainTaskLocks.delete(key)
    }
  }

  async ensureWorktree(id: TaskId | string): Promise<string> {
    const task = this.requireTask(id)
    if (task.kind === "main") return repoWorkingDir(task.repo)
    if (task.worktreePath) return task.worktreePath
    const inflight = this.worktreeLocks.get(task.id)
    if (inflight) return inflight
    const work = this.createWorktree(task)
    this.worktreeLocks.set(task.id, work)
    try {
      return await work
    } finally {
      this.worktreeLocks.delete(task.id)
    }
  }

  private async createWorktree(task: Task): Promise<string> {
    const slug = await this.slugs.allocate(task.repo)
    const branch = task.branch || autoBranch(task.title, task.id)
    const baseRef = this.pendingBaseRefs.get(task.id)
    let info: WorktreeInfo
    try {
      info = await this.worktrees.createForTask({ repo: task.repo, slug, branch, baseRef })
    } catch (err) {
      this.slugs.cancel(task.repo, slug)
      throw err
    }
    try {
      await this.store.update(task.id, { worktreePath: info.path, branch })
    } catch (err) {
      await this.rollbackWorktree(info.path)
      this.slugs.cancel(task.repo, slug)
      throw err
    }
    this.slugs.commit(task.repo, slug)
    this.pendingBaseRefs.delete(task.id)
    return info.path
  }

  private async rollbackWorktree(worktreePath: string): Promise<void> {
    try {
      await this.worktrees.remove(worktreePath, { force: true })
    } catch (err) {
      console.error(`[kobe] ensureWorktree rollback failed for ${worktreePath}:`, err)
    }
  }

  async setTitle(id: TaskId | string, title: string): Promise<void> {
    const trimmed = title.trim()
    if (!trimmed) throw new Error("setTitle: title is required (empty or whitespace-only rejected)")
    const task = this.requireTask(id)
    if (task.title === trimmed) return
    await this.store.update(task.id, { title: trimmed })
    await this.followBranchToTitle(task, trimmed)
  }

  private async followBranchToTitle(taskBefore: Task, newTitle: string): Promise<void> {
    if (taskBefore.kind === "main" || !taskBefore.worktreePath) return
    if (taskBefore.branch !== autoBranch(PLACEHOLDER_TASK_TITLE, taskBefore.id)) return
    const nextBranch = autoBranch(newTitle, taskBefore.id)
    if (nextBranch === taskBefore.branch) return
    try {
      await this.setBranch(taskBefore.id, nextBranch)
    } catch (err) {
      console.error(`[kobe] follow-branch-to-title failed for ${taskBefore.id}:`, err)
    }
  }

  async setBranch(id: TaskId | string, branch: string): Promise<void> {
    const trimmed = branch.trim()
    if (!trimmed) throw new Error("setBranch: branch is required (empty or whitespace-only rejected)")
    const task = this.requireTask(id)
    if (task.kind === "main") {
      throw new Error("setBranch: a main task tracks the repo's own branch; rename it with git directly")
    }
    if (task.branch === trimmed) return
    if (task.worktreePath) {
      await this.worktrees.renameBranch(task.worktreePath, task.branch, trimmed)
    }
    await this.store.update(task.id, { branch: trimmed })
  }

  async setVendor(id: TaskId | string, vendor: VendorId): Promise<void> {
    const task = this.requireTask(id)
    if (task.vendor === vendor) return
    await this.store.update(task.id, { vendor })
  }

  async setPinned(id: TaskId | string, pinned?: boolean): Promise<void> {
    const task = this.requireTask(id)
    if (task.kind === "main") return
    const next = pinned ?? !task.pinned
    if ((task.pinned ?? false) === next) return
    await this.store.update(task.id, { pinned: next })
  }

  async moveTask(id: TaskId | string, delta: -1 | 1): Promise<void> {
    const task = this.requireTask(id)
    if (task.kind === "main") return
    const groupIds = this.store
      .list()
      .filter(
        (t) =>
          (t.kind ?? "task") !== "main" &&
          t.archived === task.archived &&
          (t.pinned ?? false) === (task.pinned ?? false),
      )
      .map((t) => String(t.id))
    await this.store.move(task.id, delta, groupIds)
  }

  async setArchived(id: TaskId | string, archived?: boolean): Promise<void> {
    const task = this.requireTask(id)
    if (task.kind === "main") return
    const next = archived ?? !task.archived
    if (task.archived === next) return
    await this.store.update(task.id, { archived: next })
  }

  async reorderTasks(moves: ReadonlyArray<{ readonly taskId: string; readonly position: number }>): Promise<void> {
    if (moves.length === 0) return
    for (const move of moves) {
      const task = this.requireTask(move.taskId)
      if (task.kind === "main") throw new Error(`cannot reorder a main task: ${move.taskId}`)
      if (!Number.isFinite(move.position)) throw new Error(`position must be a finite number: ${move.taskId}`)
    }
    await this.store.reorder(moves.map((move) => ({ id: move.taskId, position: move.position })))
  }

  async setStatus(id: TaskId | string, status: TaskStatus): Promise<void> {
    const task = this.requireTask(id)
    if (task.status === status) return
    if ((task.status === "done" && status === "error") || (task.status === "error" && status === "done")) {
      throw new IllegalTransitionError(task.status, status, task.id)
    }
    await this.store.update(task.id, { status })
  }

  async setPRStatus(id: TaskId | string, prStatus: TaskPRStatus | null): Promise<void> {
    const task = this.requireTask(id)
    if (samePrStatus(task.prStatus, prStatus ?? undefined)) return
    await this.store.update(task.id, { prStatus: prStatus ?? undefined })
  }

  async deleteTask(id: TaskId | string, opts?: { readonly force?: boolean }): Promise<void> {
    const task = this.store.get(id)
    if (!task) return
    if (task.kind === "main") {
      throw new CannotDeleteMainTaskError()
    }
    const force = opts?.force === true
    if (task.worktreePath) {
      if (!force) {
        let dirty = false
        try {
          dirty = await this.worktrees.isDirty(task.worktreePath)
        } catch {}
        if (dirty) throw new DirtyWorktreeError(task.id)
      }
      try {
        await this.worktrees.remove(task.worktreePath, { force })
      } catch (err) {
        throw new WorktreeRemoveFailedError(task.id, err)
      }
    }
    await this.store.remove(task.id)
    this.pendingBaseRefs.delete(task.id)
    this.worktreeLocks.delete(task.id)
  }

  async forgetProject(repo: string): Promise<void> {
    if (!repo) throw new Error("forgetProject: repo is required")
    const key = normalizeMainRepo(repo).key
    for (const saved of getSavedRepos()) {
      if (normalizeMainRepo(saved).key === key) removeSavedRepo(saved)
    }
    for (const task of this.store.list()) {
      if (task.kind !== "main") continue
      if (normalizeMainRepo(task.repo).key !== key) continue
      await this.store.remove(task.id)
      this.pendingBaseRefs.delete(task.id)
      this.worktreeLocks.delete(task.id)
    }
  }

  async discoverAdoptableWorktrees(repo: string): Promise<readonly AdoptableWorktree[]> {
    if (!repo) throw new Error("discoverAdoptableWorktrees: repo is required")
    const all = await this.worktrees.listAll(repo)
    const linked = new Set(
      this.store
        .list()
        .filter((t) => t.worktreePath)
        .map((t) => canonPath(t.worktreePath)),
    )
    return all.filter((wt) => !linked.has(canonPath(wt.path)))
  }

  async adoptWorktree(input: {
    readonly repo: string
    readonly worktreePath: string
    readonly branch?: string
    readonly vendor?: VendorId
    readonly title?: string
    readonly ifExists?: "error" | "return"
  }): Promise<Task> {
    if (!input.repo) throw new Error("adoptWorktree: repo is required")
    if (!input.worktreePath) throw new Error("adoptWorktree: worktreePath is required")
    const target = canonPath(input.worktreePath)
    const inflight = this.adoptLocks.get(target)
    if (inflight) return inflight
    const work = this.adoptWorktreeLocked(input, target)
    this.adoptLocks.set(target, work)
    try {
      return await work
    } finally {
      this.adoptLocks.delete(target)
    }
  }

  private async adoptWorktreeLocked(
    input: {
      readonly repo: string
      readonly worktreePath: string
      readonly branch?: string
      readonly vendor?: VendorId
      readonly title?: string
      readonly ifExists?: "error" | "return"
    },
    target: string,
  ): Promise<Task> {
    const existing = this.store.list().find((t) => t.worktreePath && canonPath(t.worktreePath) === target)
    if (existing) {
      if (input.ifExists === "return") return existing
      throw new Error(`adoptWorktree: ${input.worktreePath} is already adopted as a task`)
    }
    const candidates = await this.worktrees.listAll(input.repo)
    const match = candidates.find((wt) => canonPath(wt.path) === target)
    if (!match) {
      throw new Error(
        `adoptWorktree: ${input.worktreePath} is not an adoptable git worktree of ${input.repo} (unknown, detached, or the main checkout)`,
      )
    }
    const branch = input.branch?.trim() || match.branch
    const title = (input.title ?? basename(match.path)).trim() || PLACEHOLDER_TASK_TITLE
    return this.store.create({
      repo: input.repo,
      title,
      branch,
      worktreePath: match.path,
      status: "backlog",
      kind: "task",
      vendor: input.vendor ?? DEFAULT_TASK_VENDOR,
    })
  }

  private readonly pendingBaseRefs = new Map<TaskId, string>()

  private readonly adoptLocks = new Map<string, Promise<Task>>()

  private requireTask(id: TaskId | string): Task {
    const task = this.store.get(id)
    if (!task) throw new TaskNotFoundError(String(id))
    return task
  }
}

function titleFromRepo(repo: string): string {
  const segs = repo.split(/[/\\]/).filter(Boolean)
  return segs.length > 0 ? (segs[segs.length - 1] ?? repo) : repo
}

function normalizeMainRepo(repo: string): { repo: string; key: string } {
  const normalized = resolveRepoRoot(repo)
  return {
    repo: normalized,
    key: isRemoteRepoKey(normalized) ? normalized : canonPath(normalized),
  }
}

function canonPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

void toTaskId
