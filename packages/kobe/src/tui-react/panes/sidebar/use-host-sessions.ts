/**
 * Poll the pty host's session inventory for the sidebar tree's orphan-tab
 * backstop (`orphan-tabs.ts` explains why the tree needs one).
 *
 * Deliberately a POLL, not a subscription: the host publishes `pty.data` to
 * ATTACHED connections only, and the whole point here is the sessions this
 * TUI never attached to. `pty.list` is a cheap in-memory read on the host,
 * and sessions appear on human timescales — the same 2s cadence the live
 * engine probe already runs at is far more than enough.
 *
 * Every failure mode resolves to "no orphans": no host running, an older
 * host without the verb, a socket that dies mid-call. The backstop only ever
 * ADDS rows, so being wrong costs a missing row, never a phantom one.
 */

import { useEffect, useState } from "react"
import { getSharedPtyClient } from "../../../tui/panes/terminal/pty-hosted-client"
import type { LiveSession } from "./orphan-tabs"

/** Matches the live-engine probe's cadence — sessions start on human time. */
const POLL_MS = 2_000

const EMPTY: readonly LiveSession[] = []

export function useHostSessions(enabled = true): readonly LiveSession[] {
  const [sessions, setSessions] = useState<readonly LiveSession[]>(EMPTY)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const client = await getSharedPtyClient()
        const { sessions: live = [] } = await client.request<{ sessions?: LiveSession[] }>("pty.list", {})
        if (!cancelled) setSessions(live)
      } catch {
        // No host / no verb / socket died — report no orphans and retry on
        // the next tick rather than tearing the poll down.
        if (!cancelled) setSessions(EMPTY)
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [enabled])

  return sessions
}
