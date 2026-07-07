import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Unix domain socket paths are stored in a fixed-size `sun_path` field
 * inside `struct sockaddr_un`. The cap differs per OS:
 *
 *   macOS / BSD : 104 bytes
 *   Linux       : 108 bytes
 *
 * We use a conservative 100-byte ceiling so even the longest reasonable
 * `bridge-<pid>.sock` suffix has room. Hitting this matters for
 * `bun run dev:sandbox` inside a deeply-nested worktree
 * (`/Users/.../.kobe/worktrees/<ULID>/packages/kobe/.dev-sandbox/...`)
 * where the natural `~/.kobe/.../daemon.sock` form blows past 104 chars
 * and `listen()` rejects silently.
 */
const SOCKET_PATH_SAFETY_LIMIT = 100

/**
 * Stable per-home short tag used as a fallback socket-name prefix when
 * the natural path overruns the kernel's `sun_path` size. Different
 * `KOBE_HOME_DIR`s map to different tags, so multiple sandbox daemons
 * (or sandbox+prod) won't collide in `$TMPDIR`.
 */
export function shortHomeTag(homeDir: string): string {
  return createHash("sha1").update(homeDir).digest("hex").slice(0, 8)
}

/**
 * Return `naturalPath` if it's within the socket-path size limit;
 * otherwise return a short `$TMPDIR/kobe-<homeTag>-<role>.sock` form
 * that's stable per (homeDir, role). The fallback name MUST be the
 * same string every time the same homeDir + role is asked — otherwise
 * the client wouldn't be able to find the daemon's socket.
 *
 * `pidTag` is used only for ephemeral sockets (the bridge spawns one
 * per daemon PID, so a stale parent's socket file is replaced on
 * restart). For the daemon socket itself the pidTag is omitted so the
 * path stays stable across daemon restarts.
 */
export function fitSocketPath(naturalPath: string, homeDir: string, role: string, pidTag?: number): string {
  if (Buffer.byteLength(naturalPath, "utf8") <= SOCKET_PATH_SAFETY_LIMIT) return naturalPath
  const tag = shortHomeTag(homeDir)
  const suffix = pidTag === undefined ? "" : `-${pidTag}`
  const fallback = join(tmpdir(), `kobe-${tag}-${role}${suffix}.sock`)
  if (Buffer.byteLength(fallback, "utf8") <= SOCKET_PATH_SAFETY_LIMIT) return fallback
  throw new Error(`kobe socket path exceeds ${SOCKET_PATH_SAFETY_LIMIT} bytes even after fallback: ${fallback}`)
}

/**
 * Resolve the unix-socket path for the kobe daemon.
 *
 * Resolution order:
 *   1. Caller-supplied `homeDir` argument → `<homeDir>/.kobe/daemon.sock`.
 *   2. Explicit `KOBE_HOME_DIR` env var → `$KOBE_HOME_DIR/.kobe/daemon.sock`.
 *   3. `XDG_RUNTIME_DIR` → `$XDG_RUNTIME_DIR/kobe.sock`.
 *   4. Default `~/.kobe/daemon.sock`.
 *
 * Every result is run through {@link fitSocketPath} so deeply-nested
 * homes (e.g. `dev:sandbox` under a worktree) fall back to a short
 * `$TMPDIR/kobe-<homeTag>-daemon.sock` instead of failing to listen.
 *
 * The XDG fallback is intentionally below the env-var step. Linux
 * desktop sessions set `XDG_RUNTIME_DIR` (e.g. `/run/user/1000`), and
 * the previous code unconditionally placed the socket there — which
 * collapsed the test-daemon and production-daemon sockets to the same
 * path, defeating `KOBE_HOME_DIR=...` isolation.
 */
export function defaultDaemonSocketPath(homeDir?: string): string {
  const override = process.env.KOBE_DAEMON_SOCKET_PATH
  if (override && override.length > 0) return override
  const explicit = homeDir ?? process.env.KOBE_HOME_DIR
  if (explicit && explicit.length > 0) {
    return fitSocketPath(join(explicit, ".kobe", "daemon.sock"), explicit, "daemon")
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (runtimeDir && runtimeDir.length > 0) {
    return fitSocketPath(join(runtimeDir, "kobe.sock"), runtimeDir, "daemon")
  }
  const home = homedir()
  return fitSocketPath(join(home, ".kobe", "daemon.sock"), home, "daemon")
}

export function defaultDaemonPidPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  const override = process.env.KOBE_DAEMON_PID_PATH
  if (override && override.length > 0) return override
  return join(homeDir, ".kobe", "daemon.pid")
}

/**
 * Log file the daemon's stdout/stderr is redirected into when it is
 * spawned as a detached background child. Without this the daemon ran
 * with `stdio: "ignore"`, so a crash (uncaught exception / unhandled
 * rejection) left no trace at all — the daemon just vanished. Keep the
 * file next to the socket + pidfile under `<home>/.kobe/`.
 */
export function defaultDaemonLogPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "daemon.log")
}

/**
 * Log file for kobe's CLIENT-side processes (the in-tmux Tasks/Ops panes
 * and the front-end attach). Unlike the daemon, these run inside an
 * opentui alternate-screen pane, so their `console.*` output is swallowed
 * by the TUI and a stray "[kobe tasks] daemon subscribe unavailable" never
 * reaches a human. Routing connection-lifecycle diagnostics to a real file
 * — next to `daemon.log` under `<home>/.kobe/` — is the only way a pane's
 * disconnect / reconnect churn is observable after the fact (the reason the
 * Tasks-pane sync drift was invisible for so long). Honours KOBE_HOME_DIR
 * like every other state path so sandbox runs stay isolated.
 */
export function defaultClientLogPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "client.log")
}

/**
 * Unix-socket path for the standalone PTY HOST process (`kobe pty-host`)
 * — the tmux-server analog that owns embedded-terminal children so they
 * survive both TUI exits AND `kobe daemon restart`. Deliberately a
 * separate process + socket from the daemon: the daemon restarts
 * routinely (it holds all the fast-moving code), while the pty host is
 * tiny and stable and must keep running. Same resolution/fitting rules
 * as {@link defaultDaemonSocketPath}.
 */
export function defaultPtyHostSocketPath(homeDir?: string): string {
  const override = process.env.KOBE_PTY_SOCKET_PATH
  if (override && override.length > 0) return override
  const explicit = homeDir ?? process.env.KOBE_HOME_DIR
  if (explicit && explicit.length > 0) {
    return fitSocketPath(join(explicit, ".kobe", "pty.sock"), explicit, "pty")
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (runtimeDir && runtimeDir.length > 0) {
    return fitSocketPath(join(runtimeDir, "kobe-pty.sock"), runtimeDir, "pty")
  }
  const home = homedir()
  return fitSocketPath(join(home, ".kobe", "pty.sock"), home, "pty")
}

export function defaultPtyHostPidPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  const override = process.env.KOBE_PTY_PID_PATH
  if (override && override.length > 0) return override
  return join(homeDir, ".kobe", "pty.pid")
}

export function defaultPtyHostLogPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "pty.log")
}
