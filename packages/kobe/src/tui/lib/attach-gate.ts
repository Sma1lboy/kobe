/**
 * Attach gate — "is anyone looking at this pane's session?"
 *
 * Every task session carries its own Tasks/Ops pane processes, and a detached
 * (background) session's panes used to keep polling at full cadence — spawning
 * git / tmux capture-pane / stat loops for a screen nobody can see. With ~10
 * sessions that was ~25 processes burning ~30% CPU at idle. The pollers now ask
 * this gate first and skip their expensive body while the session is detached;
 * the next tick after re-attach resumes normal cadence.
 *
 * One cached tmux probe (`#{session_attached}`, resolved via the pane's own
 * $TMUX context) shared by all pollers in the process, refreshed at most every
 * {@link ATTACH_TTL_MS} — so a fully detached pane process costs one tmux spawn
 * per 3s total, instead of git+capture-pane+stat every 1.5-2s each.
 *
 * Fail-open: any probe failure (no tmux server, not inside tmux — e.g. dev
 * direct runs) reports "attached", so a visible pane can never quiesce itself.
 */

import { runTmuxCapturing } from "@/tmux/client"

export const ATTACH_TTL_MS = 3000

type Probe = () => Promise<{ code: number; stdout: string }>

/** Factory (injectable for tests). Returns the cached async "attached?" check. */
export function createAttachGate(probe: Probe, now: () => number = Date.now): () => Promise<boolean> {
  let refreshedAt = Number.NEGATIVE_INFINITY
  let attached = true
  return async (): Promise<boolean> => {
    if (now() - refreshedAt < ATTACH_TTL_MS) return attached
    // Stamp before awaiting so concurrent ticks share one in-flight probe
    // window instead of stampeding spawns.
    refreshedAt = now()
    try {
      const r = await probe()
      const n = Number.parseInt(r.stdout.trim(), 10)
      attached = r.code !== 0 || Number.isNaN(n) ? true : n > 0
    } catch {
      attached = true
    }
    return attached
  }
}

/** The process-wide gate every poller shares. */
export const sessionAttached = createAttachGate(() =>
  runTmuxCapturing(["display-message", "-p", "#{session_attached}"]),
)
