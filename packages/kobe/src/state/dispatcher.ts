import { getPersistedBool } from "./store.ts"

export const DISPATCHER_KEY = "experimental.dispatcher"

export function dispatcherEnabled(): boolean {
  return getPersistedBool(DISPATCHER_KEY, false)
}
