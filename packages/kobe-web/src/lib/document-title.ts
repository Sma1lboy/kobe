/**
 * Tab-title attention badge — so a backgrounded browser tab shows "(N) kobe"
 * when N tasks need a human, the visual complement to the desktop
 * notifications (notify.ts) that works even without notification permission.
 * The "needs you" set is the Overview's attention bucket, derived through the
 * shared triage() so the tab badge and the Overview "Needs you" count never
 * disagree. Pure + React-free; the root component owns the side effect.
 */

import { triage } from "./triage.ts"
import type { EngineState, Task } from "./types.ts"

/** Product name shown in the tab (index.html's static title is the build name). */
export const BASE_TITLE = "kobe"

/**
 * Count of tasks that need a human right now — the Overview "Needs you"
 * bucket (waiting_permission / error / rate_limited). Attention never depends
 * on worktree dirtiness, so changes is intentionally omitted from triage().
 * Archived tasks and `kind: "main"` project rows are not sessions, so they
 * never count.
 */
export function attentionCount(
  tasks: readonly Task[],
  engineStates: Record<string, EngineState>,
): number {
  let count = 0
  for (const task of tasks) {
    if (task.archived || task.kind === "main") continue
    if (triage(engineStates[task.id], undefined) === "attention") count++
  }
  return count
}

/** Tab title for an attention count: "(N) kobe" when any task needs you,
 *  else the bare product name. */
export function documentTitle(count: number): string {
  return count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE
}
