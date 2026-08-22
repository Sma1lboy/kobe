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
  answeredTabsStore,
  clearAnsweredTabs,
  clearOptimisticMark,
  mergeAnsweredTabs,
  mergeOptimisticActivity,
  optimisticActivityStore,
  supersededAnswers,
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

/**
 * The per-TAB sibling: hide `permission_needed` on a tab the user has already
 * answered. Needed separately because the task entry is a last-event-wins
 * rollup — a sibling tab's activity moves it, so the badge that strands is the
 * tab's, which {@link useOptimisticEngineState} cannot reach.
 */
export function useAnsweredTabStates(
  tabStates: ReadonlyMap<string, ReadonlyMap<string, TaskEngineState>>,
): ReadonlyMap<string, ReadonlyMap<string, TaskEngineState>> {
  const answers = useAccessor(answeredTabsStore)
  const merged = useMemo(() => mergeAnsweredTabs(tabStates, answers), [tabStates, answers])
  useEffect(() => {
    clearAnsweredTabs(supersededAnswers(tabStates, answers))
  }, [tabStates, answers])
  return merged
}
