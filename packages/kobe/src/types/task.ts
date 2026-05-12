/**
 * Task data model — the orchestrator's unit of work.
 *
 * See DESIGN.md §2.4 ("One task ≈ one worktree ≈ one session") and §10
 * ("Data model"). The Task is a (worktree, branch, [chat tabs]) triple;
 * each chat tab owns its own Claude Code session. This module is the
 * on-disk shape for the manifest at `~/.kobe/tasks.json`.
 *
 * Multi-tab note (v2): the original v1 schema had a single `sessionId`
 * per Task (one session per task). v2 introduces `tabs: ChatTab[]` so a
 * single task (= one worktree) can host multiple independent chat
 * sessions. Same-worktree write conflicts are the user's concern;
 * kobe does not coordinate writes across tabs.
 *
 * Messages are NOT in this index. Messages live in Claude Code's JSONL
 * files; we read them via {@link AIEngine.readHistory}.
 */

/**
 * Branded ULID-shaped string.
 *
 * Bun has no first-party type-branding utility; we use a structural
 * brand via an unexported unique symbol. The runtime value is a plain
 * string. Use the {@link toTaskId} helper or a bare cast at boundaries
 * (e.g. when reading the manifest off disk).
 */
declare const TaskIdBrand: unique symbol
export type TaskId = string & { readonly [TaskIdBrand]: never }

/**
 * Cast a string to a {@link TaskId}. Caller asserts the value is a ULID.
 * No runtime validation — keep validators in the orchestrator layer.
 */
export const toTaskId = (id: string): TaskId => id as TaskId

/**
 * Default engine vendor for tasks that don't carry an explicit one
 * (created before the field existed, or just never had a non-claude
 * model picked). Centralised so a future "make codex the default"
 * decision is a single-line change.
 */
export const DEFAULT_TASK_VENDOR: VendorId = "claude"

/**
 * Lifecycle states for a task.
 *
 * Transitions (from DESIGN.md §5.3, made explicit here):
 *   backlog      → in_progress  (user pressed run)
 *   in_progress  → in_review    (engine emitted `done`, user wants review)
 *   in_progress  → done         (engine emitted `done`, auto-complete)
 *   in_progress  → error        (engine emitted `error`)
 *   *            → canceled     (user explicitly cancels)
 *
 * `error` is terminal but distinct from `done` — the worktree is left
 * alone for inspection.
 */
export type TaskStatus = "backlog" | "in_progress" | "in_review" | "done" | "canceled" | "error"

/**
 * Re-export of {@link PermissionMode} so callers that only depend on
 * `Task` don't have to drag in the engine module just for the type
 * union. Defined canonically in `types/engine.ts`.
 */
export type { ModelEffortLevel, PermissionMode } from "./engine.ts"
import type { ModelEffortLevel, PermissionMode } from "./engine.ts"
export type { VendorId } from "./vendor.ts"
import type { VendorId } from "./vendor.ts"

/**
 * One chat tab within a task. Each tab is a fully independent Claude
 * Code session sharing the parent task's worktree.
 */
export interface ChatTab {
  readonly id: string
  readonly sessionId: string | null
  readonly title?: string
  /**
   * Optional per-tab engine pin. When omitted, the tab inherits the
   * parent task's legacy `model` / `vendor` fields. New writes should
   * set these on the active tab so one task can host independent
   * Claude/Codex conversations without history reads crossing engines.
   */
  readonly model?: string
  readonly modelEffort?: ModelEffortLevel
  readonly vendor?: VendorId
  /**
   * Per-task display ordinal. Assigned at creation as
   * `max(existing tabs' seq) + 1`, never recomputed. The default tab
   * label is `chat ${seq}` — using the array index would renumber
   * surviving tabs whenever a middle tab gets closed.
   */
  readonly seq: number
  readonly createdAt: string
}

/**
 * Next monotonically-increasing seq for a task's chat tabs. Always
 * stable: deleting a middle tab does NOT free up its number, so the
 * displayed `chat N` for any surviving tab stays put.
 */
export function nextChatTabSeq(tabs: readonly ChatTab[]): number {
  let max = 0
  for (const t of tabs) if (t.seq > max) max = t.seq
  return max + 1
}

/**
 * Worktree directory slug for `task` — the basename of
 * `task.worktreePath`. Animal name for tasks created after KOB-65, the
 * task's ULID for older worktrees. Returns `""` for `kind: "main"`
 * tasks (which point at the repo root, not a sub-worktree) and for
 * tasks that haven't allocated a worktree yet (`backlog` state).
 *
 * Derived rather than stored: keeping it as a separate field on Task
 * just duplicates state that's already in `worktreePath`. Read through
 * this helper at every consumer (slug allocator, sidebar, diagnose).
 */
export function worktreeSlug(task: Pick<Task, "kind" | "worktreePath">): string {
  if (task.kind === "main") return ""
  if (!task.worktreePath) return ""
  // Last path segment, robust to both POSIX and Windows separators.
  // `path.basename` would do the same; inlined here to avoid a node
  // import in this types-only module.
  const match = task.worktreePath.match(/([^/\\]+)[/\\]*$/)
  return match ? (match[1] ?? "") : ""
}

/**
 * One task. Stored in `~/.kobe/tasks.json` as part of the {@link TaskIndex}.
 *
 * Field invariants:
 * - `id` is a ULID (lexicographically sortable, time-prefixed).
 * - `repo` is an absolute path to the source repo's working tree (NOT
 *   the per-task worktree — that's `worktreePath`).
 * - `worktreePath` is an absolute path; may not yet exist if the task
 *   is still in `backlog`.
 * - `tabs` is non-empty; the orchestrator refuses to close the last tab.
 * - `activeTabId` is always a valid tab id within `tabs`.
 * - `sessionId` (deprecated) is an alias for `tabs[0].sessionId`. Kept
 *   readable so older code paths and v1 manifests still load. Writers
 *   should update via tab APIs, not this field.
 * - `createdAt` and `updatedAt` are ISO-8601 strings (UTC).
 */
export interface Task {
  readonly id: TaskId
  readonly title: string
  readonly repo: string
  readonly branch: string
  readonly worktreePath: string
  /**
   * Discriminator: KOB-15 introduces a "main" task per saved repo —
   * a persistent, pinned task bound to the repo's root checkout (no
   * `git worktree add`). Regular tasks (the original shape) carry
   * `kind: "task"`. Optional in the on-disk shape: records written
   * before this field existed normalize to `"task"` at load time.
   *
   * Behavioral implications by kind:
   *   - `main` tasks set `worktreePath === repo` and `branch === ""`
   *     (the live current branch is resolved at display time, not
   *     stored). The orchestrator's `runTask` skips `ensureWorktree`
   *     for them, and `deleteTask` refuses — the user removes the
   *     repo from saved repos instead.
   *   - `task` tasks behave exactly as before.
   *
   * The on-disk discriminator is not part of TaskIndex.version: adding
   * an optional discriminator that defaults at load time is back-compat
   * with v2 readers. Mirror how `archived` and `permissionMode` were
   * added.
   */
  readonly kind?: "main" | "task"
  /**
   * @deprecated Read-only alias for `tabs[0]?.sessionId ?? null`.
   * Kept for v1 manifest back-compat and code that hasn't been
   * migrated to the multi-tab API. Do not write through this field.
   */
  readonly sessionId: string | null
  readonly tabs: readonly ChatTab[]
  readonly activeTabId: string
  readonly status: TaskStatus
  /**
   * Wave 4.5 archive flag — orthogonal to `status`. The sidebar splits
   * tasks into "Working session" (active = `archived: false`) and
   * "Archives" (`archived: true`) views, switchable with `[` / `]`.
   * Archiving is non-destructive: the worktree stays, the chat history
   * stays, the task can be unarchived (toggled with `a` again) at any
   * time. Older tasks loaded from disk that lack this field are
   * normalized to `false` at load time.
   */
  readonly archived: boolean
  /**
   * User-pinned regular tasks float to the top of the sidebar's
   * "Working session" view, just below the auto-pinned `kind: "main"`
   * rows. Optional + defaults to `false` at load time so older
   * manifests don't need migration. Toggled from the sidebar with
   * Shift+P. Orthogonal to `kind === "main"`: a main row's pin state
   * is implicit (always pinned by virtue of being a saved repo) and
   * Shift+P is a no-op on those rows.
   */
  readonly pinned?: boolean
  /**
   * Tool-permission mode passed to `claude --permission-mode <mode>`
   * on every spawn/resume. Optional: undefined falls through to the
   * CLI's `default`. Cycled in the composer via shift+tab. Records
   * written before this field existed normalize to `undefined` at
   * load time.
   */
  readonly permissionMode?: PermissionMode
  /**
   * Legacy task-level model id. Used as a fallback for tabs written
   * before model/vendor became tab-scoped. New UI writes should update
   * the active {@link ChatTab.model} instead.
   *
   * Model id passed to the engine's CLI on every spawn/resume (e.g.
   * `claude --model <id>` for claude, `codex -m <id>` for codex).
   * Optional: undefined falls through to the active vendor's default
   * (resolved via {@link EngineCapabilities.defaultModelId}).
   *
   * Vendor of the model is tracked separately in {@link vendor} — the
   * model id alone could in principle be ambiguous if two vendors ever
   * publish the same id, and an explicit field lets the orchestrator
   * route to the right engine without scanning every capability catalog
   * on each runTask.
   */
  readonly model?: string
  readonly modelEffort?: ModelEffortLevel
  /**
   * Legacy task-level engine vendor. Used as a fallback for tabs
   * written before model/vendor became tab-scoped. New UI writes
   * should update the active {@link ChatTab.vendor} instead.
   *
   * Engine vendor this task runs against. Determines which adapter the
   * orchestrator routes spawn/resume through. Optional on disk for
   * back-compat — records written before the field existed normalize
   * to {@link DEFAULT_TASK_VENDOR} (currently `"claude"`) at load time.
   *
   * Set automatically when the user picks a model from a different
   * vendor in the composer's model picker; the orchestrator infers it
   * from the picked model's catalog entry. No standalone UI to change
   * vendor without changing model — switching engine without picking a
   * new model isn't meaningful.
   */
  readonly vendor?: VendorId
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * On-disk manifest at `~/.kobe/tasks.json`.
 *
 * `version` bumps when the schema changes. v1 had `Task.sessionId` only;
 * v2 introduces `tabs` and `activeTabId`. The store migrates v1→v2 on
 * load by synthesizing one tab from the v1 sessionId.
 */
export interface TaskIndex {
  readonly version: 2
  readonly tasks: readonly Task[]
}
