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

import { loadStateFile } from "./store.ts"

export const ZEN_KEEP_TASKS_KEY = "zen.keepTasks"

/** Whether zen mode preserves the Tasks rail. Default `true`. */
export function zenKeepsTasks(): boolean {
  return loadStateFile()[ZEN_KEEP_TASKS_KEY] !== false
}
