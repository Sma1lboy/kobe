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

/**
 * True when two polls report the same sessions in the same state.
 *
 * The poll allocates a fresh array every 2s, and its consumers now include
 * the tab-title projection — which rebuilds the whole tree when this
 * changes. Comparing the fields the tree actually reads keeps a quiet host
 * render-free; a title moving (the point of the projection) still gets
 * through.
 */
function sameSessions(a: readonly LiveSession[], b: readonly LiveSession[]): boolean {
  if (a.length !== b.length) return false
  return a.every((s, i) => {
    const other = b[i] as LiveSession
    return s.key === other.key && s.alive === other.alive && s.title === other.title
  })
}

/**
 * Off under a test runner. `getSharedPtyClient` caches ONE connection per
 * process, and bun-test runs every render file in one process — so a sidebar
 * mounted by any test would connect to whatever socket was current and pin
 * that client for the whole run. `pty-hosted.test.ts` then points
 * `KOBE_PTY_SOCKET_PATH` at its own fixture server in `beforeAll`, asks for
 * the client, and gets the stale one aimed somewhere else: all ten of its
 * cases hit the 5s timeout. A backstop for orphaned rows must not be able to
 * do that to the suite that owns the real socket.
 */
function pollingAllowed(): boolean {
  return process.env.NODE_ENV !== "test" && process.env.BUN_TEST !== "1" && process.env.VITEST !== "true"
}

export function useHostSessions(enabled = pollingAllowed()): readonly LiveSession[] {
  const [sessions, setSessions] = useState<readonly LiveSession[]>(EMPTY)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const client = await getSharedPtyClient()
        const { sessions: live = [] } = await client.request<{ sessions?: LiveSession[] }>("pty.list", {})
        if (!cancelled) setSessions((prev) => (sameSessions(prev, live) ? prev : live))
      } catch {
        // No host / no verb / socket died — report no orphans and retry on
        // the next tick rather than tearing the poll down.
        if (!cancelled) setSessions((prev) => (prev.length === 0 ? prev : EMPTY))
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
