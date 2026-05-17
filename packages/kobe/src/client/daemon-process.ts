import { type StdioOptions, spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultDaemonLogPath, defaultDaemonSocketPath, fitSocketPath } from "../daemon/paths.ts"
import { KobeDaemonClient } from "./index.ts"

const DAEMON_START_ARGS = ["daemon", "start"] as const

/**
 * Spawn the detached daemon child with stdout/stderr appended to
 * `logPath`, so a crash leaves a trace. Previously the daemon ran with
 * `stdio: "ignore"` and any crash output went to `/dev/null` — the
 * daemon just vanished. Falls back to `"ignore"` if the log file can't
 * be opened (never block the daemon from starting over a log file).
 * The parent closes its copy of the fd after the fork; the child keeps
 * its own.
 */
function spawnDetachedDaemon(command: string, args: readonly string[], env: NodeJS.ProcessEnv, logPath: string): void {
  let stdio: StdioOptions = "ignore"
  let logFd: number | undefined
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    logFd = openSync(logPath, "a")
    stdio = ["ignore", logFd, logFd]
  } catch {
    stdio = "ignore"
  }
  const child = spawn(command, [...args], { detached: true, stdio, env })
  child.unref()
  if (logFd !== undefined) {
    try {
      closeSync(logFd)
    } catch {
      /* parent's copy only — child holds its own dup */
    }
  }
}

export interface OwnedDaemonClient {
  readonly client: KobeDaemonClient
  readonly socketPath: string
  readonly pidPath: string
  stop: () => Promise<void>
}

/**
 * If the daemon socket already accepts connections, do nothing. Otherwise
 * spawn a detached `kobe daemon start` and poll until the socket is
 * reachable (5s deadline). Both the TUI startup path and the in-session
 * "Restart daemon" prompt share this so the spawn+poll loop lives in
 * exactly one place.
 *
 * Returns the resolved socket path so the caller can build a client
 * pointed at it. Throws if the daemon never comes up within the deadline.
 */
export async function ensureDaemonReachable(): Promise<string> {
  const socketPath = defaultDaemonSocketPath()
  if (await testCanConnect(socketPath)) return socketPath

  const [command, ...args] = resolveKobeSpawn(DAEMON_START_ARGS)
  spawnDetachedDaemon(command, args, process.env, defaultDaemonLogPath())

  const deadline = Date.now() + 5000
  let lastErr: unknown
  while (Date.now() < deadline) {
    if (await testCanConnect(socketPath)) return socketPath
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100))
  }
  throw new Error(
    `kobe: daemon did not start at ${socketPath}: ${lastErr instanceof Error ? lastErr.message : "timeout"}`,
  )
}

export async function connectOrStartDaemon(): Promise<KobeDaemonClient> {
  const socketPath = await ensureDaemonReachable()
  const client = new KobeDaemonClient(socketPath)
  await client.connect()
  return client
}

/**
 * Start a daemon owned by the current TUI process.
 *
 * Unlike {@link connectOrStartDaemon}, this never reuses the stable
 * daemon socket. It gives each TUI its own socket/pid pair so branch/env
 * changes are picked up immediately, and so closing the TUI can stop the
 * exact daemon it started without disrupting any shared daemon elsewhere.
 */
export async function connectOrStartOwnedDaemon(): Promise<OwnedDaemonClient> {
  const homeDir = process.env.KOBE_HOME_DIR ?? homedir()
  const socketPath = fitSocketPath(join(homeDir, ".kobe", `daemon-${process.pid}.sock`), homeDir, "daemon", process.pid)
  const pidPath = join(homeDir, ".kobe", `daemon-${process.pid}.pid`)
  await ensureOwnedDaemonReachable(socketPath, pidPath)

  const client = new KobeDaemonClient(socketPath)
  await client.connect()
  return {
    client,
    socketPath,
    pidPath,
    stop: async () => {
      try {
        await client.request("daemon.stop")
      } catch {
        /* daemon may already be gone */
      } finally {
        client.close()
      }
    },
  }
}

/**
 * Start an owned daemon on a caller-chosen socket/pid path.
 *
 * Used both for initial single-daemon boot and for the disconnect
 * modal's Restart path. The important detail: reconnect must reuse the
 * existing client's socket path (`daemon-<tui pid>.sock`), not the
 * shared production daemon socket.
 */
export async function ensureOwnedDaemonReachable(socketPath: string, pidPath: string): Promise<void> {
  await unlink(socketPath).catch(() => {})

  const [command, ...args] = resolveKobeSpawn(DAEMON_START_ARGS)
  const env = {
    ...process.env,
    KOBE_DAEMON_SOCKET_PATH: socketPath,
    KOBE_DAEMON_PID_PATH: pidPath,
  }
  // Owned daemon logs sit next to its per-TUI pidfile:
  // `<home>/.kobe/daemon-<tui pid>.log`.
  const logPath = pidPath.replace(/\.pid$/, ".log")
  spawnDetachedDaemon(command, args, env, logPath)

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await testCanConnect(socketPath)) {
      return
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100))
  }
  throw new Error(`kobe: owned daemon did not start at ${socketPath}`)
}

async function testCanConnect(socketPath: string): Promise<boolean> {
  const probe = new KobeDaemonClient(socketPath)
  try {
    await probe.connect()
    probe.close()
    return true
  } catch {
    probe.close()
    return false
  }
}

/**
 * Build the argv used to spawn a detached `kobe <subcommand>` child.
 * Returns `[command, ...args]`; callers pass to `child_process.spawn`
 * as `spawn(command, args, opts)`.
 *
 * Three layouts are possible:
 *  - dev: running from source. `import.meta.url` points at
 *    `.../src/client/daemon-process.ts`; the cli entry sits at
 *    `../cli/index.ts` relative to it.
 *  - npm package: daemon-process is bundled INTO `dist/cli/index.js`, so
 *    `import.meta.url` resolves there. `../cli/index.js` resolves back
 *    to the same bundled entry — bun re-executes itself against it.
 *  - standalone: running a `bun build --compile` binary. `process.execPath`
 *    IS the kobe binary, so we re-exec it directly. After the kobed → kobe
 *    bin merge (KOB-136), no sibling lookup is needed.
 */
function resolveKobeSpawn(subcommand: readonly string[]): string[] {
  const here = fileURLToPath(import.meta.url)
  if (here.startsWith("/$bunfs") || here.startsWith("B:\\~BUN")) {
    return [process.execPath, ...subcommand]
  }
  const dir = dirname(here)
  const sourceEntry = resolve(dir, "../cli/index.ts")
  if (existsSync(sourceEntry)) return [process.execPath, sourceEntry, ...subcommand]
  const distEntry = resolve(dir, "../cli/index.js")
  if (existsSync(distEntry)) return [process.execPath, distEntry, ...subcommand]
  throw new Error(`kobe: could not locate kobe entry near ${dir}; expected ../cli/index.{ts,js}`)
}
