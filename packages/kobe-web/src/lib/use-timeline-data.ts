/** Live timeline data: settled nodes come from the engine-owned trace endpoint;
 * daemon activity overlays an immediate live head while a trace append is
 * still becoming visible. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { fetchSessions } from "./history.ts"
import { type TimelineModel, withLiveState } from "./timeline.ts"
import {
  applyLiveTraceEvent,
  fetchTrace,
  subscribeLiveTrace,
  subscribeTrace,
} from "./trace.ts"
import type { EngineState } from "./types.ts"

const POLL_MS = 1_500

export interface TimelineData {
  model: TimelineModel
  loaded: boolean
  error: string | null
}

export function useTimelineData({
  taskId,
  worktreePath,
  vendor,
  engineState,
  tabSessionId,
}: {
  taskId: string
  worktreePath: string | null
  vendor: string
  engineState: EngineState | undefined
  /** The ACTIVE tab's hook-reported session (store engineTabSessions) — fresh
   *  by construction: a relaunched engine re-reports on session-start. Wins
   *  over both the newest transcript and the task-level rollup, which is
   *  last-event-wins across tabs and can lag a whole session behind. */
  tabSessionId?: string
}): TimelineData {
  const [trace, setTrace] = useState<TimelineModel>({
    sessionId: engineState?.sessionId ?? "",
    turns: [],
  })
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState(engineState?.sessionId ?? "")
  const mtimeRef = useRef(-1)
  const seqRef = useRef(0)
  const preferredSessionId = tabSessionId ?? undefined
  const taskSessionId = engineState?.sessionId

  const refresh = useCallback(
    async (force = false): Promise<void> => {
      if (!worktreePath) return
      const seq = ++seqRef.current
      try {
        const sessions = await fetchSessions(worktreePath, vendor)
        if (!force && sessions.latestMtime === mtimeRef.current) return
        mtimeRef.current = sessions.latestMtime
        // Active tab's hook session first; otherwise the NEWEST transcript
        // (the task-level id is the last resort — it can lag a session behind).
        const latest = sessions.sessions.at(-1)
        const target = preferredSessionId ?? latest ?? taskSessionId
        const next = target
          ? await fetchTrace(vendor, target)
          : { sessionId: "", turns: [] }
        if (seq !== seqRef.current) return
        setSessionId(target ?? "")
        setTrace(next)
        setError(null)
      } catch (err) {
        if (seq === seqRef.current)
          setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (seq === seqRef.current) setLoaded(true)
      }
    },
    [worktreePath, vendor, preferredSessionId, taskSessionId],
  )

  useEffect(() => {
    mtimeRef.current = -1
    seqRef.current += 1
    setTrace({ sessionId: preferredSessionId ?? "", turns: [] })
    setSessionId(preferredSessionId ?? "")
    setLoaded(false)
    setError(null)
    void refresh(true)
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh, preferredSessionId])

  useEffect(() => {
    if (!sessionId) return
    return subscribeTrace(
      vendor,
      sessionId,
      (next) => {
        setTrace(next)
        setLoaded(true)
        setError(null)
      },
      (message) => setError(message),
    )
  }, [vendor, sessionId])

  useEffect(() => {
    if (!sessionId) return
    return subscribeLiveTrace(taskId, sessionId, (event) => {
      setTrace((current) => applyLiveTraceEvent(current, event))
    })
  }, [taskId, sessionId])

  const model = useMemo(
    () => withLiveState(trace, engineState?.state, engineState?.at ?? 0),
    [trace, engineState?.state, engineState?.at],
  )

  return { model, loaded, error }
}
