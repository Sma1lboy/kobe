/**
 * `lastActive` — THE unified word for "what was focused last" (owner
 * naming, 2026-07-08). One global record of the last active task id,
 * persisted through `state/store.ts`'s read-merge-write transaction:
 * whichever process writes last wins, deliberately WITHOUT multi-TUI
 * coordination — opening kobe lands on whatever was focused most
 * recently, anywhere. The repo/project follows from the task itself.
 *
 * Written by `Orchestrator.setActiveTask` on every focus change; read
 * once at orchestrator construction to seed the active-task signal, so a
 * daemon restart (or a fresh `kobe`) restores the last focus instead of
 * falling back to "first task in the list".
 */

import { loadStateFile, patchStateFile } from "./store.ts"

export const LAST_ACTIVE_TASK_KEY = "lastActive.taskId"

export function readLastActiveTaskId(): string | null {
  const value = loadStateFile()[LAST_ACTIVE_TASK_KEY]
  return typeof value === "string" && value ? value : null
}

/** Persist the new focus. Clearing focus (null) keeps the old record —
 *  "last active" means the last REAL focus, not the absence of one. */
export function writeLastActiveTaskId(id: string): void {
  patchStateFile({ [LAST_ACTIVE_TASK_KEY]: id })
}
