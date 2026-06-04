/**
 * Shared daemon-stop primitive (KOB-258).
 *
 * `kobe daemon restart` and `kobe reset` both need to make a daemon
 * actually GO AWAY — not just ask it to — before they continue (restart
 * respawns onto the same socket; reset leaves it stopped). The escalation
 * dance below lived inline in `daemon restart`; it's extracted here so the
 * two callers share one battle-tested kill path instead of drifting.
 *
 * Why an escalation at all: a `daemon.stop` RPC is the happy path, but a
 * wedged daemon (stuck in its own shutdown, or not servicing the socket)
 * would otherwise outlive the caller. A fresh daemon spawned onto the same
 * socket then races EADDRINUSE (or worse, two daemons end up writing one
 * `tasks.json`). So we poll the old pid with `kill -0` and escalate
 * graceful → SIGTERM → SIGKILL until it's confirmed gone.
 */

import { unlink } from "node:fs/promises"
import { KobeDaemonClient } from "../client/index.ts"
import { readPidFile } from "./server.ts"

/**
 * How {@link stopDaemonProcess} stopped the daemon — the strongest signal
 * it actually NEEDED. `"absent"` means there was no live daemon to begin
 * with (no pidfile, or a stale pidfile pointing at an already-dead
 * process), so nothing was killed — only stale socket/pidfile were
 * cleared. `"graceful"` means the `daemon.stop` RPC was enough; `"sigterm"`
 * / `"sigkill"` mean a wedged daemon had to be signalled.
 */
export type DaemonStopMethod = "absent" | "graceful" | "sigterm" | "sigkill"

export interface StopDaemonResult {
  /** The pid read from the pidfile, or `null` if there was no pidfile. */
  pid: number | null
  /** The strongest signal needed; `"absent"` means nothing live was running. */
  method: DaemonStopMethod
}

/** `kill(pid, 0)` throws ESRCH once a process is gone; EPERM means it's
 *  alive but owned by another user. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Stop the daemon listening on `socketPath`, wait until its process is
 * confirmed gone, then remove its socket + pidfile. Best-effort and
 * idempotent — calling it when no daemon is running just cleans up any
 * stale socket/pidfile and returns `{ method: "absent" }`.
 *
 * Does NOT respawn — that's the caller's job (restart respawns, reset
 * doesn't).
 */
export async function stopDaemonProcess(socketPath: string, pidPath: string): Promise<StopDaemonResult> {
  const oldPid = await readPidFile(pidPath)
  // Was a real daemon running? Decide BEFORE the graceful RPC so a stale
  // pidfile (pid points at a dead process) reports "absent" rather than
  // "graceful" — otherwise the daemon dying gracefully and the daemon
  // having been dead all along would be indistinguishable.
  const targetPid = oldPid !== null && oldPid !== process.pid ? oldPid : null
  const wasAlive = targetPid !== null && isProcessAlive(targetPid)
  let method: DaemonStopMethod = wasAlive ? "graceful" : "absent"

  // Ask the daemon to stop itself. Don't wait forever on a wedged one: if
  // `daemon.stop` doesn't round-trip in 2s we fall through to signals.
  // Harmless when nothing is listening (the connect just fails fast).
  const client = new KobeDaemonClient(socketPath)
  const stopRequest = client.request("daemon.stop").catch(() => undefined)
  const stopTimeout = new Promise<void>((resolve) => setTimeout(resolve, 2000))
  await Promise.race([stopRequest, stopTimeout])
  client.close()

  // Poll the old daemon's pid until it's actually gone. `kill -0 pid`
  // throws ESRCH once the process exits — that's our signal to proceed.
  if (wasAlive && targetPid !== null) {
    const deadline = Date.now() + 5000
    let escalated = false
    while (Date.now() < deadline) {
      try {
        process.kill(targetPid, 0)
      } catch {
        break
      }
      // Halfway through the budget, escalate from graceful stop to
      // SIGTERM — covers a daemon wedged in its own shutdown path.
      if (!escalated && Date.now() - (deadline - 5000) > 2000) {
        try {
          process.kill(targetPid, "SIGTERM")
        } catch {
          // Already gone — next iteration sees ESRCH and breaks.
        }
        method = "sigterm"
        escalated = true
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // Last resort: still alive after the budget → SIGKILL, else a respawn
    // onto the same socket path races EADDRINUSE.
    try {
      process.kill(targetPid, 0)
      process.kill(targetPid, "SIGKILL")
      method = "sigkill"
      await new Promise((resolve) => setTimeout(resolve, 100))
    } catch {
      // Already gone — happy path.
    }
  }

  // The daemon's own `serverApi.close` unlinks both files on its way out,
  // but if we had to SIGKILL it they linger and a respawn would hit
  // EADDRINUSE on the socket. Best-effort cleanup of both.
  await unlink(socketPath).catch(() => {})
  await unlink(pidPath).catch(() => {})
  return { pid: oldPid, method }
}
