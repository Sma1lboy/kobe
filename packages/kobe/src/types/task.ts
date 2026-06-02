/**
 * Task data model (v0.6).
 *
 * v0.6 reshape vs v0.5:
 *   - Drops `tabs` / `activeTabId` / `sessionId` — there's no per-task
 *     chat-tab system anymore. Each task has exactly one tmux session;
 *     the engine (claude / codex) manages its own session id on disk.
 *   - Drops `model` / `modelEffort` / `vendor` / `permissionMode` —
 *     interactive claude/codex pick those at runtime, not via kobe.
 *     The remaining `vendor` field stays only as a hint for the outer
 *     monitor's history reader ("which adapter parses this task's
 *     transcript?"). Optional with a sensible default.
 *
 * On-disk manifest moves to v3 (see `TaskIndex` below). The store
 * migrates v1/v2 records on load by stripping the dropped fields;
 * downgrading is not supported.
 */

declare const TaskIdBrand: unique symbol
export type TaskId = string & { readonly [TaskIdBrand]: never }

/**
 * Cast a string to a {@link TaskId}. Caller asserts the value is a ULID.
 * No runtime validation — keep validators in the orchestrator layer.
 */
export const toTaskId = (id: string): TaskId => id as TaskId

export type { VendorId } from "./vendor.ts"
import type { VendorId } from "./vendor.ts"

/**
 * Default engine vendor when a task doesn't record one. Centralised so
 * a future "make codex the default" decision is a one-line change.
 */
export const DEFAULT_TASK_VENDOR: VendorId = "claude"

/**
 * Lifecycle states for a task. Kept from v0.5 — the monitor still
 * needs to group by state. With claude running inside tmux the
 * transitions are user-driven (mark done / archive) rather than
 * engine-driven.
 */
export type TaskStatus = "backlog" | "in_progress" | "in_review" | "done" | "canceled" | "error"

export type PRProviderId = "github" | "gitlab" | "bitbucket" | "unknown"
export type PRCheckState = "none" | "pending" | "passing" | "failing" | "unknown"
export type PRLifecycleState = "creating" | "open" | "ready_to_merge" | "merged" | "closed" | "unknown"

/**
 * PR status persisted on Task. v0.6 keeps the shape (the monitor can
 * still display it) but the orchestrator no longer drives PR creation
 * itself — KOB-232 will re-introduce the create-PR flow via the Ops
 * pane (`tmux send-keys` into the claude pane).
 */
export interface TaskPRStatus {
  readonly provider: PRProviderId
  readonly lifecycle: PRLifecycleState
  readonly checkState: PRCheckState
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
 * One task. Stored in `~/.kobe/tasks.json` as part of {@link TaskIndex}.
 *
 * Field invariants:
 * - `id` is a ULID (lexicographically sortable, time-prefixed).
 * - `repo` is an absolute path to the source repo's working tree
 *   (NOT the per-task worktree — that's `worktreePath`).
 * - `worktreePath` is an absolute path; may not yet exist if the
 *   task is still in `backlog`. For `kind: "main"` it equals `repo`.
 * - `vendor` is a hint for the monitor's history reader; missing
 *   records normalise to `DEFAULT_TASK_VENDOR`.
 * - `createdAt` / `updatedAt` are ISO-8601 strings (UTC).
 */
export interface Task {
  readonly id: TaskId
  readonly title: string
  readonly repo: string
  readonly branch: string
  readonly worktreePath: string
  /**
   * `"main"` tasks are pinned to a saved repo's root checkout (no
   * `git worktree add`); they set `worktreePath === repo` and
   * `branch === ""`. Regular `"task"` tasks live in a per-task
   * worktree under `<repo>/.claude/worktrees/<id>/`. Optional on
   * disk: records without it normalize to `"task"` at load time.
   */
  readonly kind?: "main" | "task"
  readonly status: TaskStatus
  /**
   * Archive flag — orthogonal to `status`. The sidebar splits tasks
   * into Working / Archives views; toggle is non-destructive.
   */
  readonly archived: boolean
  /**
   * User-pinned regular tasks float to the top of the sidebar's
   * Working view. Defaults to `false` at load time.
   */
  readonly pinned?: boolean
  /**
   * Engine vendor hint — tells the monitor's history reader which
   * adapter to use when parsing this task's transcript. Optional;
   * missing values normalize to {@link DEFAULT_TASK_VENDOR}.
   */
  readonly vendor?: VendorId
  /**
   * User's manual name for the ORIGIN ChatTab window (the tmux F2 rename).
   * The window itself holds the name while its tmux server is alive; this
   * durable copy lets the chat-tab namer restore it after a server restart
   * rebuilds the window fresh — otherwise it would revert to the auto-derived
   * first-prompt name. Only the origin window is durable (extra Ctrl+T tabs
   * aren't persisted), so a single per-task field is enough. Empty / unset
   * means "no manual override; use the auto-derived name."
   */
  readonly chatTabName?: string
  readonly prStatus?: TaskPRStatus
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * On-disk manifest at `~/.kobe/tasks.json`.
 *
 * Version 3 = the v0.6 reshape. v1 (`sessionId`-only) and v2 (`tabs`)
 * manifests are migrated on load by dropping the chat-tab / model /
 * vendor / permissionMode fields. Downgrading is not supported.
 */
export interface TaskIndex {
  readonly version: 3
  readonly tasks: readonly Task[]
}
