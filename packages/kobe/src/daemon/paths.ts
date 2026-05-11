import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Resolve the unix-socket path for the kobed daemon.
 *
 * Resolution order:
 *   1. Caller-supplied `homeDir` argument → `<homeDir>/.kobe/daemon.sock`.
 *   2. Explicit `KOBE_HOME_DIR` env var → `$KOBE_HOME_DIR/.kobe/daemon.sock`.
 *   3. `XDG_RUNTIME_DIR` → `$XDG_RUNTIME_DIR/kobe.sock`.
 *   4. Default `~/.kobe/daemon.sock`.
 *
 * The XDG fallback is intentionally below the env-var step. Linux
 * desktop sessions set `XDG_RUNTIME_DIR` (e.g. `/run/user/1000`), and
 * the previous code unconditionally placed the socket there — which
 * collapsed the test-daemon and production-daemon sockets to the same
 * path, defeating `KOBE_HOME_DIR=...` isolation. `dev:sandbox` and any
 * other isolated-state caller need their own socket; honouring an
 * explicit override fixes that.
 */
export function defaultDaemonSocketPath(homeDir?: string): string {
  const explicit = homeDir ?? process.env.KOBE_HOME_DIR
  if (explicit && explicit.length > 0) return join(explicit, ".kobe", "daemon.sock")
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (runtimeDir && runtimeDir.length > 0) return join(runtimeDir, "kobe.sock")
  return join(homedir(), ".kobe", "daemon.sock")
}

export function defaultDaemonPidPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "daemon.pid")
}

export function fallbackTestSocketPath(name: string): string {
  return join(tmpdir(), `${name}-${process.pid}.sock`)
}
