/**
 * Zen mode — a one-shot "focus the engine" layout toggle that hides the
 * file/Ops pane and the terminal pane (and, when this switch is off, the
 * Tasks rail too), leaving the engine/chat pane to fill the ChatTab. The
 * toggle itself lives in `tui/panes/terminal/layout-actions.ts`; this module
 * owns only the persisted preference.
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
