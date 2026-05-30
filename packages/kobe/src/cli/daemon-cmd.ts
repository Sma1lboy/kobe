/**
 * `kobe daemon <command>` — daemon lifecycle subcommands.
 *
 * Ported from the now-removed `kobed` bin (KOB-136). The body is the same
 * logic with a different argv shape: the dispatcher in `cli/index.ts`
 * passes `rest` already trimmed of the `daemon` verb, so we read the
 * sub-command at `argv[0]` instead of `argv[2]`.
 */

import { connectOrStartDaemon } from "../client/daemon-process.ts"
import { KobeDaemonClient } from "../client/index.ts"
import { createKobeCore } from "../core/index.ts"
import { installDaemonCrashHandlers } from "../daemon/crash-log.ts"
import { stopDaemonProcess } from "../daemon/lifecycle.ts"
import { defaultDaemonPidPath, defaultDaemonSocketPath } from "../daemon/paths.ts"
import { readPidFile, startDaemonServer } from "../daemon/server.ts"

export async function runDaemonSubcommand(argv: readonly string[]): Promise<void> {
  const [command = "status"] = argv
  const socketPath = defaultDaemonSocketPath()
  const pidPath = defaultDaemonPidPath()

  if (command === "status") {
    const client = new KobeDaemonClient(socketPath)
    try {
      const status = await client.request<Record<string, unknown>>("daemon.status")
      console.log(JSON.stringify(status, null, 2))
    } catch {
      const pid = await readPidFile(pidPath)
      if (pid) console.log(`kobe daemon: no daemon socket at ${socketPath} (stale pidfile pid=${pid})`)
      else console.log(`kobe daemon: no daemon running at ${socketPath}`)
      process.exitCode = 1
    } finally {
      client.close()
    }
    return
  }

  if (command === "stop") {
    const client = new KobeDaemonClient(socketPath)
    try {
      await client.request("daemon.stop")
      console.log("kobe daemon: stop requested")
    } finally {
      client.close()
    }
    return
  }

  if (command === "restart") {
    // Stop + confirm-dead + unlink socket/pidfile via the shared
    // escalation helper (KOB-258), then respawn. Spawn the new daemon as
    // a detached child instead of becoming it ourselves — otherwise
    // `kobe daemon restart` blocks the shell forever and looks "hung" to
    // anyone running it interactively.
    await stopDaemonProcess(socketPath, pidPath)
    const next = await connectOrStartDaemon()
    next.close()
    console.log(`kobe daemon: restarted, listening on ${socketPath}`)
    return
  }

  if (command !== "start") {
    console.error("usage: kobe daemon start|stop|status|restart")
    process.exit(2)
  }

  // We ARE the daemon process from here on. Install the crash net
  // before doing any work so a stray rejection during startup (or any
  // time after) is logged to daemon.log instead of silently killing
  // the daemon. Safe here because this branch only runs in the spawned
  // daemon process, never in the TUI or tests.
  installDaemonCrashHandlers()

  const core = await createKobeCore()
  const server = await startDaemonServer(core.orchestrator, {
    socketPath,
    pidPath,
    homeDir: core.homeDir,
    onStop: async () => {
      await core.close()
    },
  })
  console.log(`kobe daemon: listening on ${server.socketPath}`)

  const shutdown = async () => {
    await server.close()
    await core.close()
    process.exit(0)
  }
  process.once("SIGINT", () => void shutdown())
  process.once("SIGTERM", () => void shutdown())
}
