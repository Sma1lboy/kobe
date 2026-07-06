/**
 * Per-task "preview mode" opt-in. When on, opening a task shows the read-only
 * LIVE history preview in the engine pane slot instead of spawning the engine —
 * the natural view for a task you're only watching (e.g. a worktree an agent is
 * working in) rather than driving. Toggled from the Tasks pane; gated behind the
 * same `experimental.archivedHistoryPreview` beta switch as the archived
 * preview, since they share the `kobe history` renderer.
 *
 * Persisted per task in the shared state.json (via the same getPersistedBool /
 * setPersistedBool the archived-preview + other UI prefs use), read fresh at
 * each enter so a toggle needs no daemon restart. Off by default.
 */

import { getPersistedBool, setPersistedBool } from "./store.ts"

const previewModeKey = (taskId: string): string => `preview.${taskId}`

/** Whether this task opens in the live read-only preview instead of the engine. */
export function previewModeEnabled(taskId: string): boolean {
  return getPersistedBool(previewModeKey(taskId), false)
}

/** Flip the task's preview mode and return the NEW state. */
export function togglePreviewMode(taskId: string): boolean {
  const next = !previewModeEnabled(taskId)
  setPersistedBool(previewModeKey(taskId), next)
  return next
}
