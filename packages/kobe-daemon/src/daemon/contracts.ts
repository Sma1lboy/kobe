/** Framework-free product contracts consumed by the daemon package. */

export type VendorId = "claude" | "codex" | "copilot" | (string & {})
export type TaskStatus = "backlog" | "in_progress" | "in_review" | "done" | "canceled" | "error"

export interface TaskPRStatus {
  readonly provider: "github" | "gitlab" | "bitbucket" | "unknown"
  readonly lifecycle: "creating" | "open" | "ready_to_merge" | "merged" | "closed" | "unknown"
  readonly checkState: "none" | "pending" | "passing" | "failing" | "unknown"
  readonly number?: number
  readonly url?: string
  readonly title?: string
  readonly baseRef?: string
  readonly headRef?: string
  readonly reviewDecision?: string
  readonly mergeable?: string
  readonly lastCheckedAt?: string
  readonly lastError?: string
}

export interface DaemonTask {
  readonly id: string
  readonly title: string
  readonly repo: string
  readonly branch: string
  readonly worktreePath: string
  readonly kind?: "main" | "task"
  readonly status: TaskStatus
  readonly archived: boolean
  readonly pinned?: boolean
  readonly vendor?: VendorId
  readonly prStatus?: TaskPRStatus
  readonly position?: number
  readonly modelEffort?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface AdoptableWorktree {
  readonly path: string
  readonly branch: string
  readonly head: string
  readonly dirty: boolean
  readonly kobeManaged: boolean
  readonly lastActivityMs: number
}

export interface DaemonOrchestrator {
  activeTaskSignal?(): (() => string | null) | undefined
  subscribeTasks(listener: (tasks: readonly DaemonTask[]) => void): () => void
  listTasks(): DaemonTask[]
  getTask(id: string): DaemonTask | undefined
  createTask(input: {
    repo: string
    title?: string
    branch?: string
    baseRef?: string
    vendor?: VendorId
    modelEffort?: string
  }): Promise<DaemonTask>
  ensureMainTask(repo: string): Promise<DaemonTask>
  ensureWorktree(id: string): Promise<string>
  forgetProject(repo: string): Promise<void>
  setTitle(id: string, title: string): Promise<void>
  setBranch(id: string, branch: string): Promise<void>
  setVendor(id: string, vendor: VendorId): Promise<void>
  setPinned(id: string, pinned?: boolean): Promise<void>
  moveTask(id: string, delta: -1 | 1): Promise<void>
  setArchived(id: string, archived?: boolean): Promise<void>
  setStatus(id: string, status: TaskStatus): Promise<void>
  setPRStatus(id: string, status: TaskPRStatus | null): Promise<void>
  reorderTasks(moves: ReadonlyArray<{ taskId: string; position: number }>): Promise<void>
  deleteTask(id: string, options?: { force?: boolean }): Promise<void>
  setActiveTask(id: string | null): Promise<void>
  discoverAdoptableWorktrees(repo: string): Promise<readonly AdoptableWorktree[]>
  adoptWorktree(input: {
    repo: string
    worktreePath: string
    branch?: string
    vendor?: VendorId
    title?: string
    ifExists: "return" | "error"
  }): Promise<DaemonTask>
}

export type EngineActivityKind =
  | "session-start"
  | "turn-start"
  | "turn-complete"
  | "turn-failed"
  | "awaiting-input"
  | "session-end"

export interface EngineActivityDetail {
  readonly failure?: "rate_limit" | "billing" | "other"
  readonly waiting?: "permission" | "input"
  readonly note?: string
}

export type TaskActivityState = "idle" | "running" | "turn_complete" | "rate_limited" | "permission_needed" | "error"

export interface UpdateInfo {
  readonly current: string
  readonly latest: string
  readonly hasUpdate: boolean
}

export interface WorktreeChanges {
  readonly added: number
  readonly deleted: number
}
