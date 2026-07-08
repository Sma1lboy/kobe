/**
 * Client-side lifecycle for the standalone PTY HOST process
 * (`kobe pty-host`, see `daemon/pty-server.ts`) — the tmux-server analog
 * that keeps embedded-terminal children alive across TUI exits AND
 * `kobe daemon restart`. Mirrors `daemon-process.ts`'s spawn-and-poll
 * shape against the pty host's own socket.
 */

import { stopDaemonProcess } from "../daemon/lifecycle.ts"
import { defaultPtyHostLogPath, defaultPtyHostPidPath, defaultPtyHostSocketPath } from "../daemon/paths.ts"
import { resolveKobeSpawn, spawnDetachedDaemon, testDaemonResponds } from "./daemon-process.ts"
import { KobeDaemonClient } from "./index.ts"

const PTY_HOST_START_ARGS = ["pty-host"] as const

/**
 * If the pty host socket already answers `hello`, do nothing. Otherwise
 * clear any wedged process and spawn a detached `kobe pty-host`, polling
 * until reachable. Returns the socket path. The terminal pane is the
 * product — it may resurrect an idle-exited host.
 */
export async function ensurePtyHostReachable(): Promise<string> {
  const socketPath = defaultPtyHostSocketPath()
  if (await testDaemonResponds(socketPath)) return socketPath

  await stopDaemonProcess(socketPath, defaultPtyHostPidPath()).catch(() => {})

  const [command, ...args] = resolveKobeSpawn(PTY_HOST_START_ARGS)
  spawnDetachedDaemon(command, args, process.env, defaultPtyHostLogPath())

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await testDaemonResponds(socketPath)) return socketPath
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100))
  }
  throw new Error(`kobe: pty host did not start (or stayed wedged) at ${socketPath}`)
}

/**
 * Fire-and-forget janitor call from the daemon: kill hosted sessions
 * whose task is archived/gone. NEVER spawns a host (nothing to sweep if
 * none is running) and never throws — the task snapshot path must not
 * fail on pty-host hiccups.
 *
 * `homeDir` MUST be the calling daemon's own home. A daemon that resolves
 * the ambient default while running against a non-default home (the
 * test:socket suite's temp-home daemons) sweeps the REAL user pty-host
 * with ITS task list — a fake orchestrator's empty snapshot then kills
 * every live engine session on the machine (incident 2026-07-07/08: every
 * `bun run test` wiped the user's running claude tabs).
 */
export async function sweepPtyHostSessions(liveTaskIds: readonly string[], homeDir?: string): Promise<void> {
  const socketPath = defaultPtyHostSocketPath(homeDir)
  const client = new KobeDaemonClient(socketPath)
  try {
    await client.connect()
    await client.request("pty.sweep", { liveTaskIds })
  } catch {
    /* no host running (or mid-exit) — nothing to sweep */
  } finally {
    client.close()
  }
}
