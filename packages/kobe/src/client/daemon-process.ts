import { type StdioOptions, spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { stopDaemonProcess } from "../daemon/lifecycle.ts"
import { defaultDaemonLogPath, defaultDaemonPidPath, defaultDaemonSocketPath, fitSocketPath } from "../daemon/paths.ts"
import { DAEMON_PROTOCOL_VERSION } from "../daemon/protocol.ts"
import { KobeDaemonClient } from "./index.ts"

const DAEMON_START_ARGS = ["daemon", "start"] as const

/**
 * How long to wait for a `hello` round-trip before declaring a daemon
 * WEDGED (process alive, socket accepting, but not servicing requests). A
 * healthy daemon answers `hello` in well under 100ms; 3s is a wide margin
 * so a momentarily-busy daemon is never mistaken for a wedged one.
 */
const DAEMON_HELLO_TIMEOUT_MS = 3000

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
  if (await testDaemonResponds(socketPath)) return socketPath

  // Not responding: the daemon is absent OR wedged (socket open, hello
  // silent). Kill any wedged process FIRST — `stopDaemonProcess` is
  // idempotent (just clears stale socket/pidfile when nothing is alive),
  // so this is safe when absent and prevents a fresh spawn from racing a
  // still-alive wedged daemon onto the same tasks.json (split-brain).
  await stopDaemonProcess(socketPath, defaultDaemonPidPath()).catch(() => {})

  const [command, ...args] = resolveKobeSpawn(DAEMON_START_ARGS)
  spawnDetachedDaemon(command, args, process.env, defaultDaemonLogPath())

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await testDaemonResponds(socketPath)) return socketPath
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100))
  }
  throw new Error(`kobe: daemon did not start (or stayed wedged) at ${socketPath}`)
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
  // Kill any prior owned daemon on this path (e.g. a wedged one left by a
  // crashed TUI) and clear its socket/pidfile before respawning, so the
  // fresh daemon doesn't race a still-alive predecessor.
  await stopDaemonProcess(socketPath, pidPath).catch(() => {})

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
    if (await testDaemonResponds(socketPath)) {
      return
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100))
  }
  throw new Error(`kobe: owned daemon did not start at ${socketPath}`)
}

/**
 * True iff a daemon at `socketPath` both accepts a connection AND answers
 * `hello` within `timeoutMs`. A socket that connects but never replies is
 * a WEDGED daemon — distinct from an absent one, and the reason we probe
 * `hello` rather than just `connect` (KOB). Any reply (even a
 * version-mismatch error) counts as "alive"; only a timeout means wedged.
 * Exported for tests.
 */
export async function testDaemonResponds(
  socketPath: string,
  timeoutMs: number = DAEMON_HELLO_TIMEOUT_MS,
): Promise<boolean> {
  const probe = new KobeDaemonClient(socketPath)
  try {
    await probe.connect()
  } catch {
    probe.close()
    return false
  }
  const replied = probe
    .request("hello", { protocolVersion: DAEMON_PROTOCOL_VERSION })
    .then(() => true)
    .catch(() => true)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const alive = await Promise.race([replied, timedOut])
  if (timer) clearTimeout(timer)
  probe.close()
  return alive
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
