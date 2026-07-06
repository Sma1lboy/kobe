import { getPersistedBool } from "./store.ts"

export const AUTO_STATUS_KEY = "experimental.autoStatus"

export function autoStatusEnabled(): boolean {
  return getPersistedBool(AUTO_STATUS_KEY, false)
}
