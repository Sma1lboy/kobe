/**
 * Pure projection logic for the background-tasks surface.
 *
 * Kept in a renderer-free module (no `@opentui/*`, no Solid) so the
 * `computeBackgroundRows` projection is unit-testable without booting a
 * terminal renderer — same split as `center-tab-strip-parts.ts`. The
 * dialog (`background-tasks-dialog.tsx`) and the status-bar indicator
 * (`background-tasks-indicator.tsx`) both render from these helpers.
 */

import type { ChatRunState } from "@/orchestrator/core"
import type { Task } from "@/types/task"

/** Sentinel string the behavior test asserts on. */
export const BACKGROUND_TASKS_DIALOG_TITLE = "kobe — background tasks"

/** Empty-state copy when nothing is running out of view. */
export const BACKGROUND_TASKS_DIALOG_EMPTY = "No sessions running in the background."

/** Footer hint — mirrors `resume-dialog`'s key-cue row. */
export const BACKGROUND_TASKS_DIALOG_FOOTER = "j/k or ↑↓ navigate • enter jump • x interrupt • esc dismiss"

/** One background session, resolved against the task store for display. */
export interface BackgroundTaskRow {
  readonly taskId: string
  readonly tabId: string
  readonly taskTitle: string
  readonly tabLabel: string
  readonly state: ChatRunState
}

/**
 * Resolve the run-state map into displayable background rows.
 *
 * Pure + exported so the status-bar indicator can reuse it (it only
 * needs `.length`) and so the projection is unit-testable without a
 * renderer. A row is included iff its `${taskId}:${tabId}` key is in
 * `runState` (i.e. running / awaiting_input) and is not `visibleKey`.
 *
 * Sort: `awaiting_input` ahead of `running` (a session blocked on the
 * user is the one they most likely opened this dialog to find), then
 * by task title for stable ordering.
 */
export function computeBackgroundRows(
  runState: ReadonlyMap<string, ChatRunState>,
  tasks: readonly Task[],
  visibleKey: string | null,
): BackgroundTaskRow[] {
  const out: BackgroundTaskRow[] = []
  for (const [key, state] of runState) {
    if (visibleKey && key === visibleKey) continue
    const sep = key.indexOf(":")
    if (sep < 0) continue
    const taskId = key.slice(0, sep)
    const tabId = key.slice(sep + 1)
    const task = tasks.find((t) => t.id === taskId)
    if (!task) continue
    const tab = task.tabs.find((t) => t.id === tabId)
    out.push({
      taskId,
      tabId,
      taskTitle: task.title,
      tabLabel: tab?.title && tab.title.length > 0 ? tab.title : `chat ${tab?.seq ?? "?"}`,
      state,
    })
  }
  out.sort((a, b) => {
    if (a.state !== b.state) return a.state === "awaiting_input" ? -1 : 1
    return a.taskTitle.localeCompare(b.taskTitle)
  })
  return out
}
