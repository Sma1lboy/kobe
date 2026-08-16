/**
 * Sidebar-only optimistic overlay (host extraction, file-size cap): local
 * enter/esc keypresses flip the row icon immediately; authoritative daemon
 * events always win, and a superseded mark is dropped so the overlay never
 * becomes a second source of truth. Store + merge rules live in
 * `optimistic-activity.ts` — this is just their React binding.
 */

import { useEffect, useMemo } from "react"
import type { TaskEngineState } from "../../client/remote-orchestrator-payloads"
import { useAccessor } from "../lib/use-accessor"
import {
  clearOptimisticMark,
  mergeOptimisticActivity,
  optimisticActivityStore,
  supersededMarks,
} from "./optimistic-activity"

export function useOptimisticEngineState(
  engineState: ReadonlyMap<string, TaskEngineState>,
): ReadonlyMap<string, TaskEngineState> {
  const optimisticMarks = useAccessor(optimisticActivityStore)
  const merged = useMemo(() => mergeOptimisticActivity(engineState, optimisticMarks), [engineState, optimisticMarks])
  useEffect(() => {
    for (const taskId of supersededMarks(engineState, optimisticMarks)) clearOptimisticMark(taskId)
  }, [engineState, optimisticMarks])
  return merged
}
