/**
 * Zen mode — a session-wide "focus the engine" layout toggle that hides the
 * file/Ops pane and the terminal pane (and, when this switch is off, the
 * Tasks rail too) across EVERY ChatTab, leaving each engine/chat pane to fill
 * its window. The toggle itself (and its session-global on/off flag) lives in
 * `tui/panes/terminal/layout-actions.ts`; this module owns only the persisted
 * `zen.keepTasks` preference.
 *
 * Stored in the shared state.json (the Settings dialog's KV writes the same
 * file) and read fresh at each toggle so flipping it needs no daemon restart.
 * Default ON — zen keeps the Tasks pane, so the create-PR-bar toggle and the
 * `prefix`-chord are always reachable to leave zen again.
 */

import { loadStateFile, patchStateFile } from "./store.ts"

export const ZEN_KEEP_TASKS_KEY = "zen.keepTasks"

/** Whether zen mode preserves the Tasks rail. Default `true`. */
export function zenKeepsTasks(): boolean {
  return loadStateFile()[ZEN_KEEP_TASKS_KEY] !== false
}

/**
 * GLOBAL on/off intent for zen mode. Each kobe task is its OWN tmux session
 * (`kobe-<taskId>`), so the per-session `@kobe_zen` option only collapses the
 * session you toggled it in — switching to another project (another session)
 * lost zen. This persisted flag is the cross-session source of truth: the
 * toggle flips it, and entering any session (`switchTo` / initial attach)
 * reconciles that session's layout to it (see `syncSessionZen`). Stored in the
 * shared state.json and read fresh, so flipping it needs no daemon restart.
 * Default OFF.
 */
export const ZEN_ACTIVE_KEY = "zen.active"

/** Whether zen mode is globally on (across every project's session). */
export function zenIsActive(): boolean {
  return loadStateFile()[ZEN_ACTIVE_KEY] === true
}

/** Persist the global zen on/off intent. */
export function setZenActive(on: boolean): void {
  patchStateFile({ [ZEN_ACTIVE_KEY]: on })
}
