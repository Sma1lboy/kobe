/** Live timeline data: settled turn/items come from the engine-owned history
 * endpoint; daemon activity overlays an immediate live head while history is
 * still being persisted. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { fetchMessages, fetchSessions, type HistoryMessage } from "./history.ts"
import { buildTimeline, type TimelineModel, withLiveState } from "./timeline.ts"
import type { EngineState } from "./types.ts"

const POLL_MS = 1_500

export interface TimelineData {
  model: TimelineModel
  loaded: boolean
  error: string | null
}

export function useTimelineData({
  worktreePath,
  vendor,
  engineState,
}: {
  worktreePath: string | null
  vendor: string
  engineState: EngineState | undefined
}): TimelineData {
  const [messages, setMessages] = useState<HistoryMessage[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mtimeRef = useRef(-1)
  const seqRef = useRef(0)
  const preferredSessionId = engineState?.sessionId

  const refresh = useCallback(
    async (force = false): Promise<void> => {
      if (!worktreePath) return
      const seq = ++seqRef.current
      try {
        const sessions = await fetchSessions(worktreePath, vendor)
        if (!force && sessions.latestMtime === mtimeRef.current) return
        mtimeRef.current = sessions.latestMtime
        const latest = sessions.sessions.at(-1)
        const target =
          preferredSessionId && sessions.sessions.includes(preferredSessionId)
            ? preferredSessionId
            : latest
        const next = target ? await fetchMessages(vendor, target) : []
        if (seq !== seqRef.current) return
        setMessages(next)
        setError(null)
      } catch (err) {
        if (seq === seqRef.current)
          setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (seq === seqRef.current) setLoaded(true)
      }
    },
    [worktreePath, vendor, preferredSessionId],
  )

  useEffect(() => {
    mtimeRef.current = -1
    seqRef.current += 1
    setMessages([])
    setLoaded(false)
    setError(null)
    void refresh(true)
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const model = useMemo(
    () =>
      withLiveState(
        buildTimeline(messages),
        engineState?.state,
        engineState?.at ?? 0,
      ),
    [messages, engineState?.state, engineState?.at],
  )

  return { model, loaded, error }
}
