import { getPersistedBool } from "./store.ts"

export const ARCHIVED_HISTORY_PREVIEW_KEY = "experimental.archivedHistoryPreview"

export function archivedHistoryPreviewEnabled(): boolean {
  return getPersistedBool(ARCHIVED_HISTORY_PREVIEW_KEY, false)
}
