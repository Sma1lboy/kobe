/**
 * Ending a PTY child — the escalation, and the bounded waits around it.
 *
 * Split from `pty-host.ts` (file-size cap), and a separate concern besides:
 * nothing here knows what a session is, only how to make a process stop and
 * how long to wait for proof. Both helpers are pure over their arguments,
 * which is what makes the platform behaviour below testable without spawning.
 */

/**
 * True if `exited` settled inside `ms`; false on timeout. A rejection counts
 * as settled — an exit is an exit however the runtime reports it.
 *
 * Every wait on a child's exit MUST go through this. `Bun.spawn`'s `exited`
 * always settles, so awaiting it bare used to be safe; the node-pty driver's
 * resolves only when ConPTY delivers `onExit`, and one wedged child would
 * otherwise hang the host's shutdown behind it.
 */
export async function settledWithin(exited: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = await Promise.race([
    exited.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
  ])
  if (timer) clearTimeout(timer)
  return settled
}

/**
 * POSIX process-group signaling for PTY children. A hosted engine spawns its
 * own subtree (shell → engine → helpers); signaling the negative pid reaches
 * the whole group, with a per-process fallback for runtimes that do not make
 * the PTY child a group leader.
 *
 * Windows has neither process groups to signal nor signals at all — the
 * fallback there lands in node-pty's `kill()`, which ignores the signal and
 * calls `TerminateProcess`. That makes even the SIGTERM step a hard kill on
 * Windows, so an engine never gets to flush; tracked separately rather than
 * papered over here.
 */
export function signalProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  fallback: () => void,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32" && pid > 1) {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // Some runtimes do not make the PTY child its own group leader.
    }
  }
  try {
    fallback()
  } catch {
    /* already gone */
  }
}
