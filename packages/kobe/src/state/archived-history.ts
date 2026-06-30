/**
 * The archived-history-preview opt-in (beta). One switch gates the read-only
 * engine-history view that replaces the live engine pane when an ARCHIVED task
 * is opened — both surfaces share this key:
 *
 *   - web: the SPA's archived-task transcript drawer (the `/api/settings`
 *     `archivedHistoryPreview` field mirrors this key),
 *   - TUI: the session-build branch that launches `kobe history` into the
 *     engine pane slot instead of the engine when a task is archived
 *     (panes/terminal/tmux.ts).
 *
 * Lives in the shared state.json (the Settings dialog's KV writes the same
 * file), read fresh at each decision point so toggling needs no daemon
 * restart. Off by default — the `experimental.` prefix follows the
 * dispatcher / auto-status / remote-projects precedent.
 */

import { getPersistedBool } from "./store.ts"

export const ARCHIVED_HISTORY_PREVIEW_KEY = "experimental.archivedHistoryPreview"

export function archivedHistoryPreviewEnabled(): boolean {
  return getPersistedBool(ARCHIVED_HISTORY_PREVIEW_KEY, false)
}
