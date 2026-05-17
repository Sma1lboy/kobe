/**
 * `kobe daemon <command>` — daemon lifecycle subcommands.
 *
 * Ported from the now-removed `kobed` bin (KOB-136). The body is the same
 * logic with a different argv shape: the dispatcher in `cli/index.ts`
 * passes `rest` already trimmed of the `daemon` verb, so we read the
 * sub-command at `argv[0]` instead of `argv[2]`.
 */

import { unlink } from "node:fs/promises"
import { connectOrStartDaemon } from "../client/daemon-process.ts"
import { KobeDaemonClient } from "../client/index.ts"
import { createKobeCore } from "../core/index.ts"
import { installDaemonCrashHandlers } from "../daemon/crash-log.ts"
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
    const oldPid = await readPidFile(pidPath)
    const client = new KobeDaemonClient(socketPath)
    // Don't wait forever on a wedged daemon. If `daemon.stop` doesn't
    // round-trip in 2s we fall through to SIGTERM below.
    const stopRequest = client.request("daemon.stop").catch(() => undefined)
    const stopTimeout = new Promise<void>((resolve) => setTimeout(resolve, 2000))
    await Promise.race([stopRequest, stopTimeout])
    client.close()
    // Poll the old daemon's pid until it's actually gone before we
    // start the new server. A fixed sleep (the previous 150ms) raced
    // against `server.close()` finishing on the old daemon and would
    // hit EADDRINUSE on `server.listen(socketPath)` whenever the
    // shutdown took longer than the sleep. `kill -0 pid` throws ESRCH
    // (process gone) — that's our signal to proceed.
    if (oldPid && oldPid !== process.pid) {
      const deadline = Date.now() + 5000
      let escalated = false
      while (Date.now() < deadline) {
        try {
          process.kill(oldPid, 0)
        } catch {
          break
        }
        // Halfway through the budget, escalate from "graceful stop" to
        // SIGTERM. Covers the case where the daemon is wedged in its
        // own shutdown path (e.g. an MCP bridge connection that didn't
        // drain) and would otherwise outlive our wait.
        if (!escalated && Date.now() - (deadline - 5000) > 2000) {
          try {
            process.kill(oldPid, "SIGTERM")
          } catch {
            // Already gone — next iteration will see ESRCH and break.
          }
          escalated = true
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      // Last resort: if the daemon is still alive after the budget,
      // SIGKILL it. Otherwise the new spawn races EADDRINUSE on the
      // socket path.
      try {
        process.kill(oldPid, 0)
        process.kill(oldPid, "SIGKILL")
        await new Promise((resolve) => setTimeout(resolve, 100))
      } catch {
        // Already gone — happy path.
      }
    }
    // The old daemon's `serverApi.close` unlinks the socket on its way
    // out, but if we had to SIGKILL it the file lingers and `listen`
    // would hit EADDRINUSE. Best-effort unlink — `connectOrStartDaemon`
    // would otherwise (re-)spawn into that same wedged state.
    await unlink(socketPath).catch(() => {})
    // Spawn the new daemon as a detached child instead of becoming it
    // ourselves — otherwise `kobe daemon restart` blocks the shell
    // forever and looks "hung" to anyone running it interactively.
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
