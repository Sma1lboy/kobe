/**
 * Parsing + summary helpers for Claude Code's two generations of
 * task-tracking tools:
 *
 *   - **TodoWrite (v1)** — ships `{ todos: [{ content, status, activeForm }] }`
 *     and is the full snapshot each call. Schema:
 *     `refs/claude-code/src/utils/todo/types.ts`.
 *   - **Task v2** — four tools (`TaskCreate / TaskUpdate / TaskList /
 *     TaskGet`) that work against an internal task store. Individual
 *     calls are incremental (one task added / one task changed); only
 *     `TaskList` returns the full set. Schemas:
 *     `refs/claude-code/src/tools/Task{Create,Update,List,Get}Tool/`.
 *
 * In Claude Code's own Ink TUI both generations hide their tool-use
 * banners (`renderToolUseMessage() => null`) and render the task list
 * in a `ctrl+t`-toggled panel. kobe takes a different shape: render the
 * full list **inline** in the chat stream (so users can scroll back
 * through how the agent's plan evolved), backed by:
 *
 *   - "snapshot" tools (TodoWrite, TaskList) — most-recent one renders
 *     full; earlier ones collapse to a status-count chip
 *     (see ToolRow's `TodoListBody`).
 *   - "action" tools (TaskCreate / TaskUpdate / TaskGet) — single-line
 *     custom banner; no inline list body.
 *
 * This module is parsing + formatting only — no JSX, so it can be
 * imported from any layer.
 */

// =============================================================================
// Shared status type
// =============================================================================

/**
 * Task v1 had three statuses; v2 adds `"deleted"` as a TaskUpdate action.
 * Deleted tasks normally do not appear in a `TaskList` result (the
 * underlying store drops them), but the parser tolerates the value so a
 * malformed-but-typed payload doesn't crash.
 */
export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted"

/** Backwards-compatible alias for the v1 callers in this file. */
export type TodoStatus = Exclude<TaskStatus, "deleted">

const TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["pending", "in_progress", "completed", "deleted"])
const V1_STATUSES: ReadonlySet<TodoStatus> = new Set<TodoStatus>(["pending", "in_progress", "completed"])

/**
 * Glyphs for the inline checklist — matches Claude Code's TaskListV2
 * choices (`refs/claude-code/src/components/TaskListV2.tsx:225-239`):
 *
 *   - completed → `figures.tick` (✓)
 *   - in_progress → `figures.squareSmallFilled` (◼)
 *   - pending → `figures.squareSmall` (◻)
 *
 * `deleted` is kobe-only — TaskList output normally strips deleted rows,
 * but if one slips through we mark it with `✗` so the parser stays
 * lossless.
 */
export const TODO_GLYPH = {
  completed: "✓",
  in_progress: "◼",
  pending: "◻",
  deleted: "✗",
} as const satisfies Record<TaskStatus, string>

// =============================================================================
// v1 — TodoWrite
// =============================================================================

export interface TodoItem {
  readonly content: string
  readonly status: TodoStatus
  readonly activeForm: string
}

/**
 * Best-effort parse of a TodoWrite tool input. Returns `[]` for anything
 * we can't make sense of so a malformed payload renders as an empty
 * list instead of crashing the row.
 */
export function parseTodos(input: unknown): readonly TodoItem[] {
  if (input == null || typeof input !== "object") return []
  const todos = (input as { todos?: unknown }).todos
  if (!Array.isArray(todos)) return []
  const out: TodoItem[] = []
  for (const t of todos) {
    if (!t || typeof t !== "object") continue
    const obj = t as Record<string, unknown>
    const content = typeof obj.content === "string" ? obj.content : ""
    const activeForm = typeof obj.activeForm === "string" ? obj.activeForm : content
    const status =
      typeof obj.status === "string" && V1_STATUSES.has(obj.status as TodoStatus)
        ? (obj.status as TodoStatus)
        : "pending"
    if (content.length === 0) continue
    out.push({ content, status, activeForm })
  }
  return out
}

/** Text to render for a todo row — activeForm while in flight, content otherwise. */
export function todoDisplayText(t: TodoItem): string {
  return t.status === "in_progress" ? t.activeForm : t.content
}

// =============================================================================
// v2 — Task* tools
// =============================================================================

export interface TaskV2Item {
  readonly id: string
  readonly subject: string
  readonly status: TaskStatus
  readonly owner?: string
  readonly blockedBy?: readonly string[]
}

function parseTaskStatus(raw: unknown): TaskStatus {
  return typeof raw === "string" && TASK_STATUSES.has(raw as TaskStatus) ? (raw as TaskStatus) : "pending"
}

function parseTaskItem(obj: Record<string, unknown>): TaskV2Item | null {
  const id = typeof obj.id === "string" ? obj.id : ""
  const subject = typeof obj.subject === "string" ? obj.subject : ""
  if (!id || !subject) return null
  return {
    id,
    subject,
    status: parseTaskStatus(obj.status),
    owner: typeof obj.owner === "string" ? obj.owner : undefined,
    blockedBy: Array.isArray(obj.blockedBy)
      ? obj.blockedBy.filter((x): x is string => typeof x === "string")
      : undefined,
  }
}

export interface TaskCreateInput {
  readonly subject: string
  readonly description: string
  readonly activeForm: string
}

export function parseTaskCreateInput(input: unknown): TaskCreateInput | null {
  if (input == null || typeof input !== "object") return null
  const obj = input as Record<string, unknown>
  const subject = typeof obj.subject === "string" ? obj.subject : ""
  if (!subject) return null
  const description = typeof obj.description === "string" ? obj.description : ""
  const activeForm = typeof obj.activeForm === "string" ? obj.activeForm : subject
  return { subject, description, activeForm }
}

export interface TaskUpdateInput {
  readonly taskId: string
  readonly status?: TaskStatus
  readonly subject?: string
  readonly activeForm?: string
  readonly owner?: string
}

export function parseTaskUpdateInput(input: unknown): TaskUpdateInput | null {
  if (input == null || typeof input !== "object") return null
  const obj = input as Record<string, unknown>
  const taskId = typeof obj.taskId === "string" ? obj.taskId : ""
  if (!taskId) return null
  return {
    taskId,
    status:
      typeof obj.status === "string" && TASK_STATUSES.has(obj.status as TaskStatus)
        ? (obj.status as TaskStatus)
        : undefined,
    subject: typeof obj.subject === "string" ? obj.subject : undefined,
    activeForm: typeof obj.activeForm === "string" ? obj.activeForm : undefined,
    owner: typeof obj.owner === "string" ? obj.owner : undefined,
  }
}

export interface TaskUpdateOutput {
  readonly success: boolean
  readonly taskId: string
  readonly updatedFields: readonly string[]
  readonly statusChange?: { readonly from: string; readonly to: string }
  readonly error?: string
}

export function parseTaskUpdateOutput(output: unknown): TaskUpdateOutput | null {
  if (output == null || typeof output !== "object") return null
  const obj = output as Record<string, unknown>
  const taskId = typeof obj.taskId === "string" ? obj.taskId : ""
  if (!taskId) return null
  const updatedFields = Array.isArray(obj.updatedFields)
    ? obj.updatedFields.filter((x): x is string => typeof x === "string")
    : []
  const sc = obj.statusChange
  const statusChange =
    sc &&
    typeof sc === "object" &&
    typeof (sc as Record<string, unknown>).from === "string" &&
    typeof (sc as Record<string, unknown>).to === "string"
      ? { from: (sc as Record<string, string>).from, to: (sc as Record<string, string>).to }
      : undefined
  return {
    success: obj.success === true,
    taskId,
    updatedFields,
    statusChange,
    error: typeof obj.error === "string" ? obj.error : undefined,
  }
}

/**
 * Parses `TaskList`'s tool result. Returns `[]` for anything malformed.
 *
 * Claude Code v2 ships TaskList through the standard tool-result
 * surface: `mapToolResultToToolResultBlockParam` formats the tasks into
 * a multi-line **string** (`#1 [completed] Subject\n#2 [pending] …`)
 * and that's what kobe's stream parser hands us as `row.output`. The
 * structured `{tasks: [...]}` form is the internal `outputSchema`, not
 * what crosses the tool-result boundary.
 *
 * To stay robust we accept both shapes:
 *   - String / Anthropic content-block array → parse the line format.
 *   - `{tasks: [...]}` object → use the structured fields (defensive
 *     fallback in case a future build pipes structured output through).
 */
export function parseTaskListOutput(output: unknown): readonly TaskV2Item[] {
  const text = coerceToolResultText(output)
  if (text != null) return parseTaskListText(text)
  if (output != null && typeof output === "object") {
    const tasks = (output as { tasks?: unknown }).tasks
    if (Array.isArray(tasks)) {
      const out: TaskV2Item[] = []
      for (const t of tasks) {
        if (!t || typeof t !== "object") continue
        const parsed = parseTaskItem(t as Record<string, unknown>)
        if (parsed) out.push(parsed)
      }
      return out
    }
  }
  return []
}

/**
 * Best-effort coercion of `row.output` (whatever the stream parser put
 * there) into a single text blob. Handles the two shapes the Anthropic
 * tool_result `content` field can take:
 *   - string — already text.
 *   - array of content blocks — concatenate the `text` blocks.
 * Returns `null` for anything else so the caller can try the structured
 * path.
 */
function coerceToolResultText(output: unknown): string | null {
  if (typeof output === "string") return output
  if (Array.isArray(output)) {
    const parts: string[] = []
    for (const b of output) {
      if (b && typeof b === "object" && (b as Record<string, unknown>).type === "text") {
        const t = (b as Record<string, unknown>).text
        if (typeof t === "string") parts.push(t)
      }
    }
    if (parts.length > 0) return parts.join("\n")
  }
  return null
}

/**
 * Parses the line format Claude Code v2's TaskList tool emits:
 *
 *   `#<id> [<status>] <subject>[ (<owner>)][ [blocked by #X, #Y]]`
 *
 * Strips the optional `(owner)` and `[blocked by ...]` suffixes so the
 * `subject` field matches the structured-schema form. Skips lines that
 * don't match (header text, blank lines, etc.) so a future Claude Code
 * build adding a preamble doesn't break the parse.
 */
function parseTaskListText(text: string): TaskV2Item[] {
  const out: TaskV2Item[] = []
  const lineRe = /^#(\S+)\s+\[(pending|in_progress|completed|deleted)\]\s+(.+)$/
  const blockedRe = /\s+\[blocked by [^\]]+\]\s*$/
  const ownerRe = /\s+\(([^)]+)\)\s*$/
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const m = lineRe.exec(line)
    if (!m) continue
    const id = m[1] ?? ""
    const status = m[2] as TaskStatus
    let rest = m[3] ?? ""
    const blocked = blockedRe.exec(rest)
    const blockedBy: string[] = []
    if (blocked) {
      const inner = blocked[0].match(/#(\S+?)(?=[,\]])/g) ?? []
      for (const tag of inner) blockedBy.push(tag.slice(1))
      rest = rest.slice(0, blocked.index).trim()
    }
    let owner: string | undefined
    const ownerM = ownerRe.exec(rest)
    if (ownerM) {
      owner = ownerM[1]
      rest = rest.slice(0, ownerM.index).trim()
    }
    if (!id || !rest) continue
    out.push({
      id,
      subject: rest,
      status,
      owner,
      blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
    })
  }
  return out
}

export interface TaskGetOutput {
  readonly task: TaskV2Item | null
}

export function parseTaskGetOutput(output: unknown): TaskGetOutput {
  if (output == null || typeof output !== "object") return { task: null }
  const raw = (output as { task?: unknown }).task
  if (!raw || typeof raw !== "object") return { task: null }
  return { task: parseTaskItem(raw as Record<string, unknown>) }
}

// =============================================================================
// Shared counting + summary
// =============================================================================

export interface TodoCounts {
  readonly done: number
  readonly inProgress: number
  readonly pending: number
  readonly total: number
}

/**
 * Counts statuses in a v1 todo list or a v2 TaskList output. `deleted`
 * tasks are excluded from the total — they don't render in the inline
 * list either, so the chip summary stays consistent.
 */
export function countTodos(items: readonly { status: TaskStatus }[]): TodoCounts {
  let done = 0
  let inProgress = 0
  let pending = 0
  let total = 0
  for (const t of items) {
    if (t.status === "deleted") continue
    total++
    if (t.status === "completed") done++
    else if (t.status === "in_progress") inProgress++
    else pending++
  }
  return { done, inProgress, pending, total }
}

/**
 * Compact glyph summary — `6 todos · ✓3 ◼1 ◻2`. Used in the in-chat
 * banner (next to the tool name), where chat width is precious and the
 * symbol form reads faster than the verbose form.
 */
export function summarizeTodos(c: TodoCounts): string {
  if (c.total === 0) return "0 todos"
  const noun = c.total === 1 ? "todo" : "todos"
  return `${c.total} ${noun} · ${TODO_GLYPH.completed}${c.done} ${TODO_GLYPH.in_progress}${c.inProgress} ${TODO_GLYPH.pending}${c.pending}`
}

/**
 * Verbose CC-style summary — `3 tasks (1 done, 1 in progress, 1 open)`.
 * Used by the composer-pinned `TodoStatusLine`, where matching Claude
 * Code's TaskListV2 header (`3 tasks (1 done, 1 in progress, 1 open)`)
 * keeps the muscle memory.
 */
export function summarizeTodosVerbose(c: TodoCounts): string {
  if (c.total === 0) return "0 tasks"
  const noun = c.total === 1 ? "task" : "tasks"
  const parts = [`${c.done} done`]
  if (c.inProgress > 0) parts.push(`${c.inProgress} in progress`)
  parts.push(`${c.pending} open`)
  return `${c.total} ${noun} (${parts.join(", ")})`
}

// =============================================================================
// Unified "snapshot item" view (consumed by ToolRow + TodoStatusLine)
// =============================================================================

/**
 * Render-friendly shape that hides the v1/v2 schema difference from the
 * UI: both `TodoWrite` (v1 input) and `TaskList` (v2 output) reduce to
 * the same `{ key, status, displayText }` row.
 *
 *   - v1: `displayText` is `activeForm` while in flight, else `content`.
 *   - v2: `displayText` is `subject [#id]` so the user can tie a row
 *     back to a later `TaskUpdate #N` event.
 */
export interface SnapshotItem {
  readonly key: string
  readonly status: TaskStatus
  readonly displayText: string
}

/**
 * Extract the **raw** snapshot items from a tool-row's input/output —
 * i.e. exactly what the tool returned, no cross-row filtering. For the
 * "rounded" view that hides items belonging to earlier rounds, use
 * {@link computeRoundedSnapshots}.
 *
 * Important: for `TaskList` (v2) the list lives in the **output**, so
 * we wait for `row.done` before parsing; an in-flight `TaskList` row
 * returns `[]` to keep the chip / list from briefly flashing empty
 * before the result comes back.
 */
export function extractSnapshotItems(row: {
  name: string
  input?: unknown
  output?: unknown
  done: boolean
}): readonly SnapshotItem[] {
  if (row.name === "TodoWrite") {
    return parseTodos(row.input).map(
      (t: TodoItem, i): SnapshotItem => ({
        key: `${i}`,
        status: t.status,
        displayText: todoDisplayText(t),
      }),
    )
  }
  if (row.name === "TaskList") {
    if (!row.done) return []
    return parseTaskListOutput(row.output).map(
      (t: TaskV2Item): SnapshotItem => ({
        key: t.id,
        status: t.status,
        displayText: `${t.subject} [#${t.id}]`,
      }),
    )
  }
  return []
}

/**
 * Minimal `ChatRow` shape the rounding pass needs. Defined here (instead
 * of importing the real `ChatRow` type from `./store`) so `todo-render`
 * stays pane-agnostic — `ChatView` happens to call it with the real
 * shape and TypeScript narrows on the `"tool"` discriminator.
 */
interface RoundingRow {
  readonly kind: string
  readonly name?: string
  readonly input?: unknown
  readonly output?: unknown
  readonly done?: boolean
}

/**
 * Cross-row "rounding" pass — for each task-snapshot row in `messages`,
 * compute the items that belong to **its round** rather than the full
 * accumulated store.
 *
 * Why this exists: v2 `TaskList` returns every task in the session
 * store. Claude Code's TUI hides older rounds by physically clearing
 * the store 5s after the plan goes all-done (`useTasksV2.ts:165`
 * `resetTaskList`). kobe spawns `claude -p` and never runs that hook,
 * so each new TaskList row drags every previously-completed task back
 * onto the screen — both in the inline chat row body and in the
 * composer-pinned panel.
 *
 * The fix: walk the chat row list once, maintain a `baseline` of task
 * ids that have already been "rounded off", and for each snapshot row
 * record only the non-baselined items as the row's *visible* slice.
 *
 * Round boundary heuristic (matches kobe's earlier in-component check):
 *   - Look at the row's raw items.
 *   - If they contain both completed and active items AND
 *     `max(completed.id) < min(active.id)`, the user has clearly moved
 *     on — every completed id below the active-id range is a previous
 *     round. Add them to `baseline` so this row's visible slice (and
 *     every later row's slice) drops them.
 *
 * Edge cases:
 *   - All-completed snapshot with no active items → nothing to round
 *     off (no "next round" has started yet). The row's visible slice is
 *     the same as raw. Once a later row introduces a new id higher than
 *     this round's max, that *later* row triggers the baseline update,
 *     and that row's slice is clean.
 *   - Non-numeric ids (theoretically possible from `parseTaskListText`
 *     if Claude Code adopts a new id scheme) → the heuristic falls back
 *     to "no rounding," which degrades to the pre-rounding behavior.
 */
export function computeRoundedSnapshots(
  messages: readonly RoundingRow[],
): ReadonlyMap<number, readonly SnapshotItem[]> {
  const result = new Map<number, readonly SnapshotItem[]>()
  const baseline = new Set<string>()
  for (let i = 0; i < messages.length; i++) {
    const r = messages[i]
    if (!r || r.kind !== "tool") continue
    if (r.name !== "TodoWrite" && r.name !== "TaskList") continue
    const raw = extractSnapshotItems({
      name: r.name,
      input: r.input,
      output: r.output,
      done: r.done === true,
    })
    if (raw.length === 0) {
      result.set(i, [])
      continue
    }

    // Round-boundary check on the **raw** snapshot — if this row's
    // contents already show "old completed + new active," promote the
    // completed half to baseline before slicing so this row's visible
    // items skip them too. Operating on raw (not the post-baseline
    // view) is intentional: a fresh TaskList output is the canonical
    // way kobe learns about a round transition.
    const rawCompleted: SnapshotItem[] = []
    const rawActive: SnapshotItem[] = []
    for (const t of raw) {
      if (t.status === "completed" || t.status === "deleted") rawCompleted.push(t)
      else rawActive.push(t)
    }
    if (rawCompleted.length > 0 && rawActive.length > 0) {
      const completedIds = rawCompleted.map((t) => Number.parseInt(t.key, 10)).filter((n) => !Number.isNaN(n))
      const activeIds = rawActive.map((t) => Number.parseInt(t.key, 10)).filter((n) => !Number.isNaN(n))
      if (
        completedIds.length === rawCompleted.length &&
        activeIds.length === rawActive.length &&
        Math.max(...completedIds) < Math.min(...activeIds)
      ) {
        for (const t of rawCompleted) baseline.add(t.key)
      }
    }

    const visible = raw.filter((t) => !baseline.has(t.key))
    result.set(i, visible)
  }
  return result
}
