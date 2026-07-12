/**
 * `kobe pty-host` — run the standalone PTY host server in the foreground
 * (this process becomes it). INTERNAL: spawned detached by
 * `ensurePtyHostReachable()` when the terminal pane needs a host; not
 * listed in `kobe --help`. See `kobe-daemon/daemon/pty-server.ts` for
 * why this is a separate process from the daemon: `kobe daemon restart`
 * must never end running engine sessions.
 */

import { installDaemonCrashHandlers } from "@sma1lboy/kobe-daemon/daemon/crash-log"
import { startPtyHostServer } from "@sma1lboy/kobe-daemon/daemon/pty-server"

export async function runPtyHostSubcommand(_argv: readonly string[]): Promise<void> {
  // Crash net first: a stray rejection must land in the log, not silently
  // kill the process that owns every background engine session.
  installDaemonCrashHandlers()

  const server = await startPtyHostServer({
    log: (event, message) => console.log(`[pty-host ${event}] ${message}`),
    // Idle-exit path: the server already closed itself; just end the process.
    onStop: () => process.exit(0),
  })
  console.log(`kobe pty-host: listening on ${server.socketPath}`)

  const shutdown = async () => {
    await server.close()
    process.exit(0)
  }
  process.once("SIGINT", () => void shutdown())
  process.once("SIGTERM", () => void shutdown())
}
