/** Live timeline data: settled nodes come from the engine-owned trace endpoint;
 * daemon activity overlays an immediate live head while a trace append is
 * still becoming visible. */

import { useEffect, useMemo, useRef, useState } from "react"
import { type TimelineModel, withLiveState } from "./timeline.ts"
import {
  applyLiveTraceEvent,
  fetchTrace,
  subscribeLiveTrace,
  subscribeTrace,
} from "./trace.ts"
import type { EngineSessionBinding, EngineState } from "./types.ts"

export type TimelineBindingState = EngineSessionBinding["state"] | "unavailable"

export interface TimelineData {
  model: TimelineModel
  loaded: boolean
  error: string | null
  bindingState: TimelineBindingState
}

/** A native transcript is session-scoped and therefore contains turns from
 * earlier resumes. The pane is run-scoped: keep turns whose lifetime overlaps
 * this ChatTab attachment. SessionStart may arrive after an argv prompt has
 * begun, so start-time containment would incorrectly hide the first turn. */
export function traceForRun(trace: TimelineModel, startedAt: number): TimelineModel {
  if (startedAt <= 0) return trace
  return {
    ...trace,
    turns: trace.turns.filter((turn) => (turn.endedAt ?? Number.POSITIVE_INFINITY) >= startedAt),
  }
}

export function useTimelineData({
  taskId,
  vendor,
  engineState,
  binding,
  legacySessionId,
}: {
  taskId: string
  vendor: string
  engineState: EngineState | undefined
  /** Durable daemon-owned identity. Terminal pixels never select history. */
  binding?: EngineSessionBinding
  /** Exact-id fallback from a pre-binding daemon; never a newest-file guess. */
  legacySessionId?: string
}): TimelineData {
  const targetSessionId = binding?.sessionId ?? legacySessionId ?? ""
  const runKey = binding?.runId ?? targetSessionId
  const runStartedAt = binding?.startedAt ?? 0
  const bindingState: TimelineBindingState =
    binding?.state ?? (legacySessionId ? "bound" : "unavailable")
  const [trace, setTrace] = useState<TimelineModel>({
    sessionId: targetSessionId,
    turns: [],
  })
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seqRef = useRef(0)

  useEffect(() => {
    const seq = ++seqRef.current
    setTrace({ sessionId: targetSessionId, turns: [] })
    setLoaded(false)
    setError(null)
    if (!targetSessionId) {
      setLoaded(true)
      return
    }
    void fetchTrace(vendor, targetSessionId)
      .then((next) => {
        if (seq !== seqRef.current) return
        setTrace(traceForRun(next, runStartedAt))
        setLoaded(true)
      })
      .catch((err) => {
        if (seq !== seqRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setLoaded(true)
      })
  }, [vendor, targetSessionId, runKey, runStartedAt])

  useEffect(() => {
    if (!targetSessionId) return
    return subscribeTrace(
      vendor,
      targetSessionId,
      (next) => {
        setTrace(traceForRun(next, runStartedAt))
        setLoaded(true)
        setError(null)
      },
      (message) => setError(message),
    )
  }, [vendor, targetSessionId, runKey, runStartedAt])

  useEffect(() => {
    if (!targetSessionId) return
    return subscribeLiveTrace(taskId, targetSessionId, (event) => {
      if (event.at < runStartedAt) return
      setTrace((current) => applyLiveTraceEvent(current, event))
    })
  }, [taskId, targetSessionId, runKey, runStartedAt])

  const model = useMemo(
    () => withLiveState(trace, engineState?.state, engineState?.at ?? 0),
    [trace, engineState?.state, engineState?.at],
  )

  return { model, loaded, error, bindingState }
}
