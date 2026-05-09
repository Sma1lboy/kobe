/**
 * Task data model — the orchestrator's unit of work.
 *
 * See DESIGN.md §2.4 ("One task ≈ one worktree ≈ one session") and §10
 * ("Data model"). The Task is a triple of (worktree, Claude Code session,
 * branch); this module is the on-disk shape for the manifest at
 * `~/.kobe/tasks.json`.
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
 * One task. Stored in `~/.kobe/tasks.json` as part of the {@link TaskIndex}.
 *
 * Field invariants:
 * - `id` is a ULID (lexicographically sortable, time-prefixed).
 * - `repo` is an absolute path to the source repo's working tree (NOT
 *   the per-task worktree — that's `worktreePath`).
 * - `worktreePath` is an absolute path; may not yet exist if the task
 *   is still in `backlog`.
 * - `sessionId` is null until the engine has spawned at least once.
 * - `createdAt` and `updatedAt` are ISO-8601 strings (UTC).
 */
export interface Task {
  readonly id: TaskId
  readonly title: string
  readonly repo: string
  readonly branch: string
  readonly worktreePath: string
  readonly sessionId: string | null
  readonly status: TaskStatus
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * On-disk manifest at `~/.kobe/tasks.json`.
 *
 * `version` is a literal `1` so future migrations can branch on it.
 * When (not if) the schema changes, bump the literal and write a
 * migration — never silently mutate the shape.
 */
export interface TaskIndex {
  readonly version: 1
  readonly tasks: readonly Task[]
}
