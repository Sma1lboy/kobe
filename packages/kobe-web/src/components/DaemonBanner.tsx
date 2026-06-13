/**
 * Daemon-offline banner — shown when the SSE stream is up but the daemon
 * behind the bridge is down (panes go read-only / stale until it recovers).
 * Extracted from AppShell so the /board and /issues routes can render it
 * standalone (those routes don't mount the full shell).
 */

import { X } from "lucide-react"
import { useState } from "react"
import { useAppState } from "../lib/store.ts"

export function DaemonBanner() {
  const { daemonConnected, streamConnected, hydrated } = useAppState()
  const [dismissed, setDismissed] = useState(false)
  // Only meaningful once we've hydrated and the SSE stream is up but the
  // daemon behind the bridge is down — panes go read-only / stale until it
  // comes back. A dropped SSE stream is a different state (TopBar shows it).
  const down = hydrated && streamConnected && !daemonConnected
  if (!down || dismissed) return null
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-kobe-yellow/40 bg-kobe-yellow/10 px-3 py-1.5 text-[11px] text-kobe-yellow">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-kobe-yellow" />
      <span className="min-w-0 flex-1">
        The kobe daemon is offline — task data is frozen and mutations will fail
        until it reconnects (it auto-reconnects; the dashboard recovers on its
        own). If it doesn't recover, run <code>kobe doctor</code> or{" "}
        <code>kobe reset</code> in a terminal.
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 text-kobe-yellow/70 hover:text-kobe-yellow"
        aria-label="dismiss"
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  )
}
