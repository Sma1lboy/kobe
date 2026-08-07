/** Framework-free product contracts consumed by the daemon package. */

export type VendorId = "claude" | "codex" | "copilot" | (string & {})
export type TaskStatus = "backlog" | "in_progress" | "in_review" | "done" | "canceled" | "error"

export type EngineSessionStartSource = "startup" | "resume" | "clear" | "compact"

/** One temporal attachment of an engine-native conversation to a hosted tab.
 * A native session can appear in several runs when it is resumed; a tab can
 * point at several runs over its lifetime as users clear, fork, or resume. */
export interface EngineRun {
  readonly runId: string
  readonly taskId: string
  readonly tabId: string
  readonly vendor: VendorId
  /** Null while the engine has started but has not reported its native id. */
  readonly sessionId: string | null
  readonly state: "pending" | "bound" | "ended" | "superseded" | "missing"
  /** Which authoritative boundary supplied the current identity. */
  readonly source: "spawn" | "observer" | "hook" | "history-recovery"
  /** Native SessionStart cause. `compact` stays in the current run; the other
   * causes establish a new temporal run after any pending spawn is filled. */
  readonly startSource?: EngineSessionStartSource
  readonly transcriptPath?: string
  /** Epoch milliseconds for the engine spawn this binding belongs to. */
  readonly startedAt: number
  readonly boundAt?: number
  readonly endedAt?: number
  readonly updatedAt: number
}

/** Backward-compatible name for the current run published per task/tab. */
export type EngineSessionBinding = EngineRun
export type EngineSessionBindingsByTask = Record<string, Record<string, EngineSessionBinding>>

/** Ephemeral native-session transition. It deliberately stays outside the
 * durable EngineRun ledger until the engine identifies the selected session. */
export interface EngineSessionTransition {
  readonly taskId: string
  readonly tabId: string
  readonly vendor: VendorId
  readonly startSource: "resume"
  readonly observedAt: number
}

export type EngineSessionTransitionsByTask = Record<string, Record<string, EngineSessionTransition>>

export interface TaskDeletionState {
  readonly phase: "queued" | "running" | "error"
  readonly force: boolean
  readonly requestedAt: string
  readonly error?: string
}

/** One engine-neutral quota window (mirrors kobe/types/engine.ts). */
export interface EngineQuotaWindow {
  readonly kind: string
  readonly label: string
  /** Integer utilization percent, 0..100. */
  readonly percent: number
  /** Epoch-ms window reset, or null when the vendor didn't report one. */
  readonly resetsAt: number | null
}

/** Snapshot of an engine account's quota windows (mirrors kobe/types/engine.ts). */
export interface EngineQuotaUsage {
  readonly windows: readonly EngineQuotaWindow[]
  readonly capturedAt: number
}

/** Durable rate-limit auto-resume schedule (mirrors kobe/types/task.ts). */
export interface TaskQuotaResumeState {
  /** ISO-8601 time the provider's exhausted quota window resets. */
  readonly resumeAt: string
  /** ISO-8601 time the rate limit was observed and this schedule written. */
  readonly requestedAt: string
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

/**
 * A worker's SELF-REPORTED terminal outcome (`task.report`). The field name
 * carries the provenance: this is the worker's claim, never verified by kobe.
 */
export interface TaskWorkerReport {
  readonly outcome: "succeeded" | "failed"
  readonly summary?: string
  /** ISO-8601, stamped by the daemon when the report arrived. */
  readonly reportedAt: string
}

/** Pointer back to the external issue a task was started from. Snapshot for
 *  display; `url` is the durable way to the live item. Never synced. */
export interface TaskLinkedWorkItem {
  readonly provider: "github"
  readonly type: "issue" | "pr"
  readonly number: number
  readonly title: string
  readonly url: string
}

export interface DaemonTask {
  readonly id: string
  readonly title: string
  readonly repo: string
  readonly branch: string
  readonly worktreePath: string
  readonly kind?: "main" | "task" | "dir"
  readonly status: TaskStatus
  readonly archived: boolean
  readonly pinned?: boolean
  readonly vendor?: VendorId
  readonly prStatus?: TaskPRStatus
  readonly position?: number
  readonly modelEffort?: string
  readonly groupId?: string
  readonly workerReport?: TaskWorkerReport
  readonly deletion?: TaskDeletionState
  readonly quotaResume?: TaskQuotaResumeState
  /** The external tracker item this task was started from, when it was. */
  readonly linkedWorkItem?: TaskLinkedWorkItem
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
    groupId?: string
  }): Promise<DaemonTask>
  ensureMainTask(repo: string): Promise<DaemonTask>
  /** Open an existing directory as a standalone `kind:"dir"` task (`kobe .`). */
  openDirectoryTask(input: { dir: string; vendor?: VendorId }): Promise<DaemonTask>
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
  /** Store a worker's self-reported outcome verbatim (worker report, not kobe-verified). */
  setWorkerReport(id: string, report: TaskWorkerReport): Promise<void>
  /** Stamp the external tracker item a task was started from. */
  setLinkedWorkItem(id: string, item: TaskLinkedWorkItem | null): Promise<void>
  /** Arm (or clear, with `null`) the rate-limit auto-resume schedule. */
  setQuotaResume(id: string, state: TaskQuotaResumeState | null): Promise<void>
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
  | "turn-interrupted"
  | "awaiting-input"
  | "session-end"
  // Lifecycle-only kinds — plugin-facing, never folded into the activity badge.
  | "tool-pre"
  | "tool-post"
  | "tool-failed"
  | "pre-compact"
  | "post-compact"
  | "subagent-start"
  | "subagent-stop"

export interface EngineActivityDetail {
  readonly failure?: "rate_limit" | "billing" | "other"
  readonly waiting?: "permission" | "input"
  readonly turnId?: string
  readonly tool?: {
    readonly name?: string
    readonly id?: string
    readonly input?: string
    readonly output?: string
    readonly isError?: boolean
  }
  readonly compact?: { readonly trigger?: "manual" | "auto" }
  readonly subagent?: {
    readonly type?: string
    readonly id?: string
    readonly transcriptPath?: string
    readonly result?: string
  }
  readonly note?: string
}

export type TaskActivityState = "idle" | "running" | "turn_complete" | "rate_limited" | "permission_needed" | "error"

/** States represented by pending Inbox items until handled or the same
 * Terminal Tab starts another turn. */
export const ATTENTION_INBOX_STATES = [
  "turn_complete",
  "permission_needed",
  "error",
  "rate_limited",
] as const satisfies readonly TaskActivityState[]

export type AttentionInboxState = (typeof ATTENTION_INBOX_STATES)[number]

export function isAttentionInboxState(value: unknown): value is AttentionInboxState {
  return typeof value === "string" && (ATTENTION_INBOX_STATES as readonly string[]).includes(value)
}

export function attentionInboxItemKey(item: { taskId: string | null; tabId: string | null }): string {
  return `${item.taskId}\0${item.tabId ?? ""}`
}

/** One daemon-owned, durable attention episode for a task's engine tab. */
export interface AttentionInboxItem {
  readonly taskId: string
  /** `null` for hook events that predate or lack a tab identity. */
  readonly tabId: string | null
  readonly state: AttentionInboxState
  readonly detail?: EngineActivityDetail
  /** Compatibility field ignored by the queue model; new episodes set it to `true`. */
  readonly unread: boolean
  /** Event time, epoch milliseconds. Stable across daemon/TUI restarts. */
  readonly at: number
}

/** A shell command run BEFORE an automation's engine starts. A non-zero exit
 *  means "nothing to do" and the run is skipped without spawning an engine —
 *  the cheap way to stop a schedule burning a turn when nothing changed. */
export interface AutomationPrecheck {
  readonly command: string
  readonly timeoutSeconds: number
}

/**
 * One scheduled agent task: a cron rule + a prompt + a repo. Every firing
 * creates a FRESH task (worktree + branch + engine session), so an automation
 * run is an ordinary task you can open and keep talking to.
 *
 * `nextRunAt` is the whole scheduling story: an absolute timestamp on disk,
 * never an in-memory timer. A daemon restart needs no re-arm pass — the first
 * sweep after boot re-reads it (same shape as `Task.quotaResume`).
 */
export interface Automation {
  readonly id: string
  readonly name: string
  /** Absolute repo root; resolved once at create time. */
  readonly repo: string
  /** Delivered as the engine's launch-time first message. */
  readonly prompt: string
  readonly vendor?: VendorId
  /** Five-field cron, evaluated in the daemon host's local time. */
  readonly schedule: string
  readonly precheck?: AutomationPrecheck
  readonly baseRef?: string
  readonly enabled: boolean
  /** ISO-8601. The single source of truth for when this fires next. */
  readonly nextRunAt: string
  /** How late a missed occurrence may still run. Older ones are skipped. */
  readonly missedRunGraceMinutes: number
  readonly lastRunAt?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * Why a run did or did not produce work. The four "didn't run" reasons are
 * deliberately distinct: unattended automation is only trustworthy if the user
 * can tell "nothing to do" (`skipped_precheck`, healthy) from "it broke"
 * (`dispatch_failed`, needs a human) at a glance.
 */
export type AutomationRunStatus =
  | "dispatched"
  | "skipped_precheck"
  | "skipped_missed"
  | "skipped_unavailable"
  | "dispatch_failed"

export interface AutomationPrecheckResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

export interface AutomationRun {
  readonly id: string
  readonly automationId: string
  /** Monotonic per automation; survives retention pruning. */
  readonly runNumber: number
  /** When this occurrence was SUPPOSED to run — not when it actually did. */
  readonly scheduledFor: string
  readonly status: AutomationRunStatus
  readonly trigger: "scheduled" | "manual"
  readonly taskId?: string
  readonly precheckResult?: AutomationPrecheckResult
  readonly error?: string
  /** ISO-8601 event time. */
  readonly at: string
}

/** Mutable fields of an automation. `schedule` changes recompute `nextRunAt`. */
export interface AutomationPatch {
  readonly name?: string
  readonly prompt?: string
  readonly vendor?: VendorId
  readonly schedule?: string
  readonly precheck?: AutomationPrecheck | null
  readonly baseRef?: string | null
  readonly enabled?: boolean
  readonly missedRunGraceMinutes?: number
}

export interface UpdateInfo {
  readonly current: string
  readonly latest: string
  readonly hasUpdate: boolean
}

export interface WorktreeChanges {
  readonly added: number
  readonly deleted: number
  /** Current branch (from `--branch`'s `##` header); absent without it. */
  readonly branch?: string
}
