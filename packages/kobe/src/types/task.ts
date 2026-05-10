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
export type { PermissionMode } from "./engine.ts"
import type { PermissionMode } from "./engine.ts"

/**
 * One chat tab within a task. Each tab is a fully independent Claude
 * Code session sharing the parent task's worktree.
 */
export interface ChatTab {
  readonly id: string
  readonly sessionId: string | null
  readonly title?: string
  readonly createdAt: string
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
   * Tool-permission mode passed to `claude --permission-mode <mode>`
   * on every spawn/resume. Optional: undefined falls through to the
   * CLI's `default`. Cycled in the composer via shift+tab. Records
   * written before this field existed normalize to `undefined` at
   * load time.
   */
  readonly permissionMode?: PermissionMode
  /**
   * Model id passed to `claude --model <id>` on every spawn/resume.
   * Optional: undefined falls through to the CLI's default model.
   * Picked from a fixed set in the composer's model picker; full
   * Anthropic model ids are stored verbatim so the persisted choice
   * survives kobe restarts and matches what claude-code itself uses.
   */
  readonly model?: string
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
