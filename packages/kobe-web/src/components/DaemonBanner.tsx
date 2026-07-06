import { X } from "lucide-react"
import { useState } from "react"
import { useAppState } from "../lib/store.ts"
import { shouldShowDaemonOfflineBanner } from "../lib/web-transport.ts"

export function DaemonBanner() {
  const { daemonConnected, streamConnected, hydrated } = useAppState()
  const [dismissed, setDismissed] = useState(false)
  const down = shouldShowDaemonOfflineBanner({
    daemonConnected,
    streamConnected,
    hydrated,
  })
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
