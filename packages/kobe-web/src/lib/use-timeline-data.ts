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

// A local trace fetch often resolves inside one paint. Keep resume transitions
// visible long enough to communicate that the pane changed session identity.
const MIN_RESUME_LOADING_MS = 360

function wait(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((resolve) => window.setTimeout(resolve, ms))
    : Promise.resolve()
}

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
  const targetGeneration =
    binding?.runId ??
    (targetSessionId ? `legacy:${vendor}:${targetSessionId}` : "")
  const runStartedAt = binding?.startedAt ?? 0
  const bindingState: TimelineBindingState =
    binding?.state ?? (legacySessionId ? "bound" : "unavailable")
  const [trace, setTrace] = useState<TimelineModel>({
    sessionId: targetSessionId,
    turns: [],
  })
  const [loaded, setLoaded] = useState(false)
  const [loadedGeneration, setLoadedGeneration] = useState("")
  const [error, setError] = useState<string | null>(null)
  const seqRef = useRef(0)
  const previousGenerationRef = useRef(targetGeneration)

  // Props change before effects run. Mask the previous run synchronously so a
  // resumed session can never paint the old timeline under its new identity.
  const generationReady =
    !targetSessionId ||
    (loaded &&
      loadedGeneration === targetGeneration &&
      trace.sessionId === targetSessionId)

  useEffect(() => {
    const seq = ++seqRef.current
    const previousGeneration = previousGenerationRef.current
    previousGenerationRef.current = targetGeneration
    const startedAt = Date.now()
    const minimumLoadingMs =
      previousGeneration &&
      previousGeneration !== targetGeneration &&
      binding?.startSource === "resume"
        ? MIN_RESUME_LOADING_MS
        : 0
    setTrace({ sessionId: targetSessionId, turns: [] })
    setLoaded(false)
    setError(null)
    if (!targetSessionId) {
      setLoadedGeneration(targetGeneration)
      setLoaded(true)
      return
    }
    void fetchTrace(vendor, targetSessionId)
      .then(async (next) => {
        await wait(minimumLoadingMs - (Date.now() - startedAt))
        if (seq !== seqRef.current) return
        // Engine history is session-scoped. Resuming away from a session and
        // later returning to it must restore its complete persisted timeline;
        // EngineRun timestamps identify the live attachment, not a history
        // retention boundary.
        setTrace(next)
        setLoadedGeneration(targetGeneration)
        setLoaded(true)
      })
      .catch(async (err) => {
        await wait(minimumLoadingMs - (Date.now() - startedAt))
        if (seq !== seqRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setLoadedGeneration(targetGeneration)
        setLoaded(true)
      })
  }, [vendor, targetSessionId, targetGeneration, binding?.startSource])

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

  const model = useMemo(() => {
    if (!generationReady)
      return { sessionId: targetSessionId, turns: [] } satisfies TimelineModel
    return withLiveState(trace, engineState?.state, engineState?.at ?? 0)
  }, [
    generationReady,
    targetSessionId,
    trace,
    engineState?.state,
    engineState?.at,
  ])

  return {
    model,
    loaded: generationReady,
    error: generationReady ? error : null,
    bindingState,
  }
}
