/**
 * "Jump to the next task that needs you" — closes the attention loop: the
 * desktop notifications and the tab-title badge tell you SOMETHING is waiting,
 * this picks which task to open next. The attention set is the Overview's
 * "Needs you" bucket via the shared triage(), and "next" cycles through it
 * relative to the currently-active task so repeated invocations walk every
 * waiting task. Pure + React-free; the command palette wires it.
 */

import { triage } from "./triage.ts"
import type { EngineState, Task } from "./types.ts"

/** Ids of tasks needing a human (waiting_permission / error / rate_limited),
 *  in the given task order. Archived tasks and project (main) rows excluded. */
export function attentionTaskIds(
  tasks: readonly Task[],
  engineStates: Record<string, EngineState>,
): string[] {
  return tasks
    .filter(
      (t) =>
        !t.archived &&
        t.kind !== "main" &&
        triage(engineStates[t.id], undefined) === "attention",
    )
    .map((t) => t.id)
}

/**
 * The next attention task to open: the one after `activeId` in the attention
 * list (wrapping at the end), or the first when the active task isn't itself
 * waiting. Returns null when nothing needs you — the caller hides the command
 * rather than offering a no-op.
 */
export function nextAttentionTaskId(
  ids: readonly string[],
  activeId: string | null,
): string | null {
  if (ids.length === 0) return null
  const idx = activeId ? ids.indexOf(activeId) : -1
  if (idx === -1) return ids[0] ?? null
  return ids[(idx + 1) % ids.length] ?? null
}
