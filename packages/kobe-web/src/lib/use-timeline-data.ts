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
        // Engine history is session-scoped. Resuming away from a session and
        // later returning to it must restore its complete persisted timeline;
        // EngineRun timestamps identify the live attachment, not a history
        // retention boundary.
        setTrace(next)
        setLoaded(true)
      })
      .catch((err) => {
        if (seq !== seqRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setLoaded(true)
      })
  }, [vendor, targetSessionId])

  useEffect(() => {
    if (!targetSessionId) return
    return subscribeTrace(
      vendor,
      targetSessionId,
      (next) => {
        setTrace(next)
        setLoaded(true)
        setError(null)
      },
      (message) => setError(message),
    )
  }, [vendor, targetSessionId])

  useEffect(() => {
    if (!targetSessionId) return
    return subscribeLiveTrace(taskId, targetSessionId, (event) => {
      if (event.at < runStartedAt) return
      setTrace((current) => applyLiveTraceEvent(current, event))
    })
  }, [taskId, targetSessionId, runStartedAt])

  const model = useMemo(
    () => withLiveState(trace, engineState?.state, engineState?.at ?? 0),
    [trace, engineState?.state, engineState?.at],
  )

  return { model, loaded, error, bindingState }
}
