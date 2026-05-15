/**
 * Composite-key utilities for `(taskId, tabId)` pairs.
 *
 * Lots of in-memory maps key by tab — engine handles, event-bus
 * subscribers, run-state, daemon client subscriptions, completion
 * notifications, etc. The shape `${taskId}:${tabId}` got hand-composed
 * across ~13 modules before this consolidation; centralising it here
 * removes a class of "two modules drift on the separator" bugs and
 * makes refactors that ever want to change the shape a single-file
 * change.
 *
 * Format: `${taskId}:${tabId}`. `:` was chosen because neither ULIDs
 * (task ids) nor the slug-shaped tab ids contain it. There is **no**
 * branding on the returned string — kobe doesn't enforce nominal
 * typing on string keys, and the cost of doing so (every Map<string,T>
 * declaration needing the brand) outweighs the rare benefit.
 */

import type { TaskId } from "./task.ts"

/** Compose a tab key from its parts. */
export function tabKey(taskId: TaskId | string, tabId: string): string {
  return `${taskId}:${tabId}`
}

/**
 * Split a tab key back into its parts. Returns `null` when the input
 * is not a valid tab key (no `:` separator, or empty taskId / tabId).
 * Used when iterating a `Map<tabKey, ...>` and needing to attribute
 * entries back to their owning task/tab.
 */
export function parseTabKey(key: string): { taskId: string; tabId: string } | null {
  const idx = key.indexOf(":")
  if (idx <= 0 || idx >= key.length - 1) return null
  return { taskId: key.slice(0, idx), tabId: key.slice(idx + 1) }
}

/**
 * True iff `key` is a tab key belonging to `taskId`. Faster than
 * parsing the key when the caller only needs the boolean — useful for
 * "tear down every subscription/handle for this task" sweeps.
 */
export function tabKeyMatchesTask(key: string, taskId: TaskId | string): boolean {
  return key.startsWith(`${taskId}:`)
}
