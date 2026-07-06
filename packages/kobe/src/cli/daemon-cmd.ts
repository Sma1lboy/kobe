/**
 * `kobe daemon <command>` — daemon lifecycle subcommands.
 *
 * Ported from the now-removed `kobed` bin. The body is the same
 * logic with a different argv shape: the dispatcher in `cli/index.ts`
 * passes `rest` already trimmed of the `daemon` verb, so we read the
 * sub-command at `argv[0]` instead of `argv[2]`.
 */

import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { installDaemonCrashHandlers } from "@sma1lboy/kobe-daemon/daemon/crash-log"
import { stopDaemonProcess } from "@sma1lboy/kobe-daemon/daemon/lifecycle"
import { defaultDaemonPidPath, defaultDaemonSocketPath } from "@sma1lboy/kobe-daemon/daemon/paths"
import { readPidFile, startDaemonServer } from "@sma1lboy/kobe-daemon/daemon/server"
import { createKobeCore } from "../core/index.ts"

function printDaemonUsage(out: Pick<typeof process.stderr, "write">): void {
  out.write(
    [
      "Usage: kobe daemon <command>",
      "",
      "Commands:",
      "  status     Print the running daemon's status JSON (default)",
      "  start      Run the daemon in the foreground (this process becomes it)",
      "  stop       Ask the running daemon to shut down",
      "  restart    Stop the daemon (graceful → SIGTERM → SIGKILL) and respawn it",
      "",
    ].join("\n"),
  )
}

function resolveDaemonWebPort(): number | undefined {
  const raw = process.env.KOBE_DAEMON_WEB_PORT?.trim()
  if (raw === "0" || raw === "off" || raw === "false") return undefined
  const value = raw ? Number.parseInt(raw, 10) : 5174
  return Number.isFinite(value) && value > 0 ? value : 5174
}

export async function runDaemonSubcommand(argv: readonly string[]): Promise<void> {
  const [command = "status"] = argv
  const socketPath = defaultDaemonSocketPath()
  const pidPath = defaultDaemonPidPath()

  if (command === "--help" || command === "-h" || command === "help") {
    printDaemonUsage(process.stdout)
    return
  }

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
    } catch {
      // No daemon answering the socket → "stop" is already satisfied. Report
      // it cleanly and exit 0 (a defensive `daemon stop` in a teardown script
      // must not fail just because nothing was running) rather than letting
      // the connection error bubble to the top-level "failed to start" catch.
      console.log(`kobe daemon: no daemon running at ${socketPath}`)
    } finally {
      client.close()
    }
    return
  }

  if (command === "restart") {
    // Stop + confirm-dead + unlink socket/pidfile via the shared
    // escalation helper, then respawn. Spawn the new daemon as
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
    process.stderr.write(`kobe daemon: unknown command "${command}"\n\n`)
    printDaemonUsage(process.stderr)
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
    webPort: resolveDaemonWebPort(),
    webHost: process.env.KOBE_WEB_HOST,
    webStaticDir: process.env.KOBE_DAEMON_WEB_STATIC_DIR,
    onStop: async () => {
      await core.close()
    },
  })
  console.log(`kobe daemon: listening on ${server.socketPath}`)
  if (server.webPort) console.log(`kobe daemon: web transport listening on http://127.0.0.1:${server.webPort}`)

  const shutdown = async () => {
    await server.close()
    await core.close()
    process.exit(0)
  }
  process.once("SIGINT", () => void shutdown())
  process.once("SIGTERM", () => void shutdown())
}
