import { type StdioOptions, spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { stopDaemonProcess } from "../daemon/lifecycle.ts"
import { defaultDaemonLogPath, defaultDaemonPidPath, defaultDaemonSocketPath } from "../daemon/paths.ts"
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
export function spawnDetachedDaemon(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  logPath: string,
): void {
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

/**
 * True when this process runs INSIDE a kobe engine session — the launch
 * script exports `KOBE_TASK_ID` into every engine tab. Helpers there (an
 * agent's `kobe api`, a hook) must never KILL the shared daemon: a daemon
 * that's merely busy past the hello timeout looks "wedged" from here, and
 * the old stop-then-spawn path replaced it with a session-env clone — the
 * 2026-07-13 zombie/socket-steal incident.
 */
function insideEngineSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.KOBE_TASK_ID === "string" && env.KOBE_TASK_ID !== ""
}

/**
 * Env for an AUTOSPAWNED daemon: drop the spawning process's engine-session
 * identity (a helper inside an engine tab must not stamp its task/tab/TUI
 * markers onto a long-lived shared daemon) and set the autospawn flag the
 * daemon's lifetime policy reads (first-gui grace — a spawned daemon whose
 * client never attaches as a gui reaps itself instead of living forever).
 * Exported for tests.
 */
export function autospawnDaemonEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { KOBE_TASK_ID: _task, KOBE_TAB_ID: _tab, KOBE_TUI: _tui, KOBE_TERMINAL_PTY: _pty, ...rest } = env
  return { ...rest, KOBE_DAEMON_AUTOSPAWNED: "1" }
}

/**
 * If the daemon socket already answers, do nothing. Otherwise spawn a
 * detached `kobe daemon start` (session-scrubbed env, autospawn-flagged —
 * see {@link autospawnDaemonEnv}) and poll until the socket is reachable
 * (5s deadline). Both the TUI startup path and the in-session "Restart
 * daemon" prompt share this so the spawn+poll loop lives in exactly one
 * place. Returns the resolved socket path; throws if the daemon never
 * comes up — or, inside an engine session, when the daemon is wedged
 * (session helpers never kill/replace the shared daemon).
 */
export async function ensureDaemonReachable(): Promise<string> {
  const socketPath = defaultDaemonSocketPath()
  const state = await probeDaemonSocket(socketPath)
  if (state === "alive") return socketPath

  if (state === "wedged" && insideEngineSession()) {
    // The socket CONNECTS but hello is slow — a busy daemon is
    // indistinguishable from a wedged one from in here, and killing the
    // shared daemon from a session helper is how split-brain starts.
    // Leave recovery to the human-driven path (a real TUI boot / `kobe
    // doctor`); fail with the cause instead.
    throw new Error(
      `kobe: daemon at ${socketPath} is not answering hello (busy or wedged); not restarting it from inside an engine session — retry, or run \`kobe daemon restart\` from a regular shell`,
    )
  }

  // Absent, or wedged outside a session: kill any wedged process FIRST —
  // `stopDaemonProcess` is idempotent (just clears stale socket/pidfile
  // when nothing is alive) and prevents a fresh spawn from racing a
  // still-alive wedged daemon onto the same tasks.json (split-brain).
  await stopDaemonProcess(socketPath, defaultDaemonPidPath()).catch(() => {})

  const [command, ...args] = resolveKobeSpawn(DAEMON_START_ARGS)
  spawnDetachedDaemon(command, args, autospawnDaemonEnv(), defaultDaemonLogPath())

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await testDaemonResponds(socketPath)) return socketPath
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100))
  }
  throw new Error(
    `kobe: daemon did not start (or stayed wedged) at ${socketPath}; check ${defaultDaemonLogPath()} or run \`kobe doctor\``,
  )
}

export async function connectOrStartDaemon(): Promise<KobeDaemonClient> {
  const socketPath = await ensureDaemonReachable()
  const client = new KobeDaemonClient(socketPath)
  await client.connect()
  return client
}

/**
 * Connect to the daemon ONLY if one is already running and responsive —
 * never spawn one. Returns `null` when the daemon is absent or wedged.
 * For side-effect-light commands (e.g. `kobe add`'s worktree scan) that
 * want to sync with a live daemon when present but must not boot one as
 * a side effect.
 */
export async function connectIfRunning(): Promise<KobeDaemonClient | null> {
  const socketPath = defaultDaemonSocketPath()
  if (!(await testDaemonResponds(socketPath))) return null
  const client = new KobeDaemonClient(socketPath)
  await client.connect()
  return client
}

/** What a socket probe found: answering, nothing there, or a socket that
 *  connects but won't answer hello (busy past the timeout, or truly hung). */
export type DaemonSocketState = "alive" | "absent" | "wedged"

/**
 * Probe the daemon at `socketPath`: does it accept a connection, and does
 * it answer `hello` within `timeoutMs`? A socket that connects but never
 * replies is WEDGED — distinct from an absent one, and the reason we probe
 * `hello` rather than just `connect` (KOB). Any reply (even a
 * version-mismatch error) counts as alive; only a timeout means wedged.
 * Exported for tests.
 */
export async function probeDaemonSocket(
  socketPath: string,
  timeoutMs: number = DAEMON_HELLO_TIMEOUT_MS,
): Promise<DaemonSocketState> {
  const probe = new KobeDaemonClient(socketPath)
  try {
    await probe.connect()
  } catch {
    probe.close()
    return "absent"
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
  return alive ? "alive" : "wedged"
}

/** Back-compat boolean view of {@link probeDaemonSocket}. */
export async function testDaemonResponds(
  socketPath: string,
  timeoutMs: number = DAEMON_HELLO_TIMEOUT_MS,
): Promise<boolean> {
  return (await probeDaemonSocket(socketPath, timeoutMs)) === "alive"
}

/**
 * Build the argv used to spawn a detached `kobe <subcommand>` child.
 * Returns `[command, ...args]`; callers pass to `child_process.spawn`
 * as `spawn(command, args, opts)`.
 *
 * Four layouts are possible:
 *  - dev, pre-extraction: running from kobe source. `import.meta.url`
 *    points at `.../src/client/daemon-process.ts`; the cli entry sits at
 *    `../cli/index.ts` relative to it.
 *  - dev, daemon workspace: running from `packages/kobe-daemon` source.
 *    The cli entry sits in sibling workspace `packages/kobe/src/cli`.
 *  - npm package: daemon-process is bundled INTO `dist/cli/index.js`, so
 *    `import.meta.url` resolves there. `../cli/index.js` resolves back
 *    to the same bundled entry — bun re-executes itself against it.
 *  - standalone: running a `bun build --compile` binary. `process.execPath`
 *    IS the kobe binary, so we re-exec it directly. After the kobed → kobe
 *    bin merge, no sibling lookup is needed.
 */
export function resolveKobeSpawn(subcommand: readonly string[]): string[] {
  const here = fileURLToPath(import.meta.url)
  if (here.startsWith("/$bunfs") || here.startsWith("B:\\~BUN")) {
    return [process.execPath, ...subcommand]
  }
  const dir = dirname(here)
  const candidates = [
    resolve(dir, "../cli/index.ts"),
    resolve(dir, "../../../kobe/src/cli/index.ts"),
    resolve(dir, "../cli/index.js"),
  ]
  const entry = candidates.find((candidate) => existsSync(candidate))
  if (entry) return [process.execPath, entry, ...subcommand]
  throw new Error(`kobe: could not locate kobe entry near ${dir}; checked ${candidates.join(", ")}`)
}
