/**
 * Ending a PTY child — the escalation, and the bounded waits around it.
 *
 * Split out of `pty-host.ts` because it is a different concern from the
 * session registry: nothing here knows what a session is, only how to make a
 * process stop and how long to wait for proof. Both helpers are pure over
 * their arguments, which is also what makes the platform behaviour below
 * testable without spawning anything.
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
 * Signal a child's whole process group, falling back to the child alone.
 *
 * The group form is what reaches an engine's own subprocesses; POSIX gets it
 * via `kill(-pid)`. Windows has no process groups to signal and no signals at
 * all — the fallback there ends up in node-pty's `kill()`, which ignores the
 * signal and calls `TerminateProcess`. That makes even the SIGTERM step a hard
 * kill on Windows, so an engine never gets to flush; tracked separately rather
 * than papered over here.
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
