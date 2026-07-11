/** React adapter for the framework-free Orchestrator state interface. */

import { useSyncExternalStore } from "react"
import type { ReadableState } from "../../lib/external-store"

export function useAccessor<T>(state: ReadableState<T>): T {
  return useSyncExternalStore(state.subscribe, state.get, state.get)
}
