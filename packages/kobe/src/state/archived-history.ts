/**
 * The archived-history-preview opt-in (beta). One switch gates the read-only
 * engine-history view for archived tasks. The web settings API mirrors this
 * key, and the TUI settings dialog can toggle it.
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
