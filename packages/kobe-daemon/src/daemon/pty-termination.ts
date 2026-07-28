/**
 * POSIX process-group signaling for PTY children. A hosted engine spawns
 * its own subtree (shell → engine → helpers); signaling the negative pid
 * reaches the whole group, with a per-process fallback for runtimes that
 * do not make the PTY child a group leader. Split from `pty-host.ts`
 * (file-size cap) — pure side-effect helper, no session state.
 */

export function signalProcessGroup(pid: number, signal: NodeJS.Signals, fallback: () => void): void {
  if (process.platform !== "win32" && pid > 1) {
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
