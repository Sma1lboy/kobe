import { getPersistedBool, setPersistedBool } from "./store.ts"

export const ZEN_KEEP_TASKS_KEY = "zen.keepTasks"

export function zenKeepsTasks(): boolean {
  return getPersistedBool(ZEN_KEEP_TASKS_KEY, true)
}

export const ZEN_ACTIVE_KEY = "zen.active"

export function zenIsActive(): boolean {
  return getPersistedBool(ZEN_ACTIVE_KEY, false)
}

export function setZenActive(on: boolean): void {
  setPersistedBool(ZEN_ACTIVE_KEY, on)
}
