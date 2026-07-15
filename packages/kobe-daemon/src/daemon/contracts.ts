/** Framework-free product contracts consumed by the daemon package. */

export type VendorId = "claude" | "codex" | "copilot" | (string & {})
export type TaskStatus = "backlog" | "in_progress" | "in_review" | "done" | "canceled" | "error"

export interface TaskDeletionState {
  readonly phase: "queued" | "running" | "error"
  readonly force: boolean
  readonly requestedAt: string
  readonly error?: string
}

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
  readonly deletion?: TaskDeletionState
  readonly createdAt: string
  readonly updatedAt: string
}

/** Result of a `task.land` — mirrors the orchestrator's `LandResult`. */
export interface LandResult {
  readonly branch: string
  readonly strategy: "merge" | "squash"
  readonly landedOn: string
  readonly commit: string
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
  prepareTaskDeletion(id: string, options?: { force?: boolean }): Promise<boolean>
  beginTaskDeletion(id: string): Promise<boolean>
  finishTaskDeletion(id: string): Promise<void>
  landTask(
    id: string,
    options?: { strategy?: "merge" | "squash"; deleteBranch?: boolean; archive?: boolean },
  ): Promise<LandResult>
  setActiveTask(id: string | null): Promise<void>
  /** Clear a task's worktreePath (keep its branch) after an out-of-band worktree removal. */
  clearWorktreePath(id: string): Promise<void>
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

/** States retained as unresolved Inbox episodes until a newer same-tab turn starts. */
export type AttentionInboxState = Extract<
  TaskActivityState,
  "turn_complete" | "permission_needed" | "error" | "rate_limited"
>

/** One daemon-owned, durable attention episode for a task's engine tab. */
export interface AttentionInboxItem {
  readonly taskId: string
  /** `null` for hook events that predate or lack a tab identity. */
  readonly tabId: string | null
  readonly state: AttentionInboxState
  readonly detail?: EngineActivityDetail
  /** Cleared only when this exact episode is opened; survives reconnects. */
  readonly unread: boolean
  /** Event time, epoch milliseconds. Stable across daemon/TUI restarts. */
  readonly at: number
}

export interface UpdateInfo {
  readonly current: string
  readonly latest: string
  readonly hasUpdate: boolean
}

export interface WorktreeChanges {
  readonly added: number
  readonly deleted: number
}
