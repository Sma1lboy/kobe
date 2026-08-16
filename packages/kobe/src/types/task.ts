/**
 * Task data model (v0.6).
 *
 * Tasks persist Worktree and lifecycle metadata. Terminal-tab state and live
 * Hosted PTY sessions have their own owners; engine conversation ids remain
 * engine-owned on disk.
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
 * Lifecycle states used by sidebar grouping and automation.
 */
export type TaskStatus = "backlog" | "in_progress" | "in_review" | "done" | "canceled" | "error"

/**
 * The runtime list of every {@link TaskStatus} — the single source of truth a
 * wire-boundary validator checks against, so an inbound `status` string is
 * confirmed with `isTaskStatus(x)` instead of a hand-maintained `!==` chain
 * that silently drifts when a status is added. The `satisfies` clause makes the
 * compiler reject this list if it ever falls out of sync with the union.
 */
export const TASK_STATUSES = [
  "backlog",
  "in_progress",
  "in_review",
  "done",
  "canceled",
  "error",
] as const satisfies readonly TaskStatus[]

// Exhaustiveness: if a member is added to TaskStatus but not to TASK_STATUSES,
// `Exclude` is non-`never` and this `satisfies` fails to compile.
true satisfies Exclude<TaskStatus, (typeof TASK_STATUSES)[number]> extends never ? true : false

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)
}

export type PRProviderId = "github" | "gitlab" | "bitbucket" | "unknown"
export type PRCheckState = "none" | "pending" | "passing" | "failing" | "unknown"
export type PRLifecycleState = "creating" | "open" | "ready_to_merge" | "merged" | "closed" | "unknown"

/**
 * PR status persisted on Task. v0.6 keeps the shape (the monitor can
 * still display it) but the orchestrator no longer drives PR creation
 * itself; create-PR flows ask the active engine through Hosted PTY delivery.
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

export type TaskDeletionPhase = "queued" | "running" | "error"

/** Durable state for daemon-owned background worktree cleanup. */
export interface TaskDeletionState {
  readonly phase: TaskDeletionPhase
  readonly force: boolean
  /** Opt-in: also delete the task's git branch. Default (absent/false) keeps
   *  the branch — git history is the durable record, the task row is not. */
  readonly deleteBranch?: boolean
  readonly requestedAt: string
  readonly error?: string
}

/**
 * Durable schedule for the daemon's rate-limit auto-resume: the engine hit
 * its subscription quota and the provider reported when the window resets.
 * The daemon's quota-resume runner delivers a continue prompt into the
 * task's live engine session once `resumeAt` passes, then clears this.
 */
export interface TaskQuotaResumeState {
  /** ISO-8601 time the provider's exhausted window resets. */
  readonly resumeAt: string
  /** ISO-8601 time the rate limit was observed and this schedule written. */
  readonly requestedAt: string
}

/**
 * Provenance of the kobe session that created this task: which task and
 * which terminal tab dispatched it (from the creating CLI process's
 * `$KOBE_TASK_ID` / `$KOBE_TAB_ID`). This is the reply address for the
 * collaboration loop — a sub-task's bare `send` routes its outcome back to
 * this exact tab. Absent when the task was created outside a kobe session
 * (TUI dialog, plain shell) and on records that predate the field.
 */
export interface TaskDispatcher {
  readonly taskId: string
  readonly tabId: string
}

/**
 * One task. Stored in `~/.rove/tasks.json` as part of {@link TaskIndex}.
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
   * worktree under `~/.rove/worktrees/<repo-key>/<slug>/` (or global/repo-local
   * `.kobe/worktrees` / legacy `.claude/worktrees` for older records).
   * `"dir"` tasks (`rove .`) pin an arbitrary existing directory the
   * user opened directly: `worktreePath === repo`, `branch === ""`, no
   * project association, and deletion only drops the index entry — the
   * directory itself is never removed.
   * Optional on disk: records without it normalize to `"task"` at load time.
   */
  readonly kind?: "main" | "task" | "dir"
  /**
   * A SCRATCH shell task (issue #33): a `kind: "dir"` task whose cwd is not
   * settled yet — an ad-hoc shell opened to poke around, living in the
   * sidebar's Scratch section instead of a project group. Zero-ceremony
   * lifecycle: its shell exiting deletes the row outright. The flag CLEARS
   * when the task earns a place — the user renames it (`setTitle`) or its
   * live cwd + a detected harness migrate it into a project
   * (`adoptScratchRepo`) — after which it is an ordinary directory task.
   */
  readonly scratch?: boolean
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
   * Engine PROTOCOL hint — tells the monitor's history reader which
   * adapter to use when parsing this task's transcript. Optional;
   * missing values normalize to {@link DEFAULT_TASK_VENDOR}.
   *
   * Derived from {@link command}, not declared beside it: `rove api add
   * --command …` resolves the protocol from the command's argv[0]
   * (`engine/engine-presets.ts`), and a command kobe cannot name records
   * the generic protocol until a live session is sniffed. Records that
   * predate `command` carry a preset id here and launch from it, so the
   * two fields stay interchangeable at the launch site.
   */
  readonly vendor?: VendorId
  /**
   * The RAW launch command for this task's engine — what the dispatch
   * face (`add --command` / `set-command`) was given, verbatim. Either a
   * registered preset id (built-in or custom, whose `engineCommand.<id>`
   * override still applies) or a full command line. Absent on records
   * created before the field, which launch from {@link vendor} instead.
   */
  readonly command?: string
  readonly prStatus?: TaskPRStatus
  /**
   * Manual ordering key within a status column on the WEB BOARD only —
   * a sparse fractional number assigned by `task.reorder` drops. The TUI
   * sidebar never reads it (tasks.json array order stays the TUI's
   * `default` sort). Cards without one sort by creation time on the board.
   */
  readonly position?: number
  /**
   * Reasoning/effort level for the task's engine, when the vendor supports
   * one (codex: `none`/`low`/`medium`/`high`/`xhigh`). Optional + additive:
   * missing records load unchanged, and a vendor with no effort levels
   * (claude today) leaves it undefined. The launch path maps it to the
   * vendor-correct flag (see `interactive-command.ts`).
   */
  readonly modelEffort?: string
  /**
   * Fan-out round marker: every sibling created by one `kobe api fan-out`
   * call shares a ULID, so the round survives the CLI call that created it
   * (grouping, aggregate notifications, round-level operations). Optional +
   * additive: single tasks never get one.
   */
  readonly groupId?: string
  /** Present while background deletion is queued/running or after it failed. */
  readonly deletion?: TaskDeletionState
  /** Present while a rate-limited engine waits for its quota window to reset. */
  readonly quotaResume?: TaskQuotaResumeState
  /** The external tracker item this task was started from, when it was. */
  readonly linkedWorkItem?: TaskLinkedWorkItem
  /** The kobe session (task + tab) that dispatched this task, when one did. */
  readonly dispatcher?: TaskDispatcher
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * A pointer back to the issue in someone else's tracker that this task exists
 * to address. Stamped once at creation and never synced: the fields are a
 * SNAPSHOT for display, and `url` is the durable way back to the live item.
 * kobe deliberately does not mirror the item's state (see `work-items.ts`).
 */
export interface TaskLinkedWorkItem {
  readonly provider: "github"
  readonly type: "issue" | "pr"
  readonly number: number
  /** Title as it read when the task was started. */
  readonly title: string
  readonly url: string
}

/**
 * On-disk manifest at `~/.rove/tasks.json`.
 *
 * Version 3 = the v0.6 reshape. v1 (`sessionId`-only) and v2 (`tabs`)
 * manifests are migrated on load by dropping the chat-tab / model /
 * vendor / permissionMode fields. Downgrading is not supported.
 */
export interface TaskIndex {
  readonly version: 3
  readonly tasks: readonly Task[]
}
