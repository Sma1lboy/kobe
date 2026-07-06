import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const SOCKET_PATH_SAFETY_LIMIT = 100

export function shortHomeTag(homeDir: string): string {
  return createHash("sha1").update(homeDir).digest("hex").slice(0, 8)
}

export function fitSocketPath(naturalPath: string, homeDir: string, role: string, pidTag?: number): string {
  if (Buffer.byteLength(naturalPath, "utf8") <= SOCKET_PATH_SAFETY_LIMIT) return naturalPath
  const tag = shortHomeTag(homeDir)
  const suffix = pidTag === undefined ? "" : `-${pidTag}`
  const fallback = join(tmpdir(), `kobe-${tag}-${role}${suffix}.sock`)
  if (Buffer.byteLength(fallback, "utf8") <= SOCKET_PATH_SAFETY_LIMIT) return fallback
  throw new Error(`kobe socket path exceeds ${SOCKET_PATH_SAFETY_LIMIT} bytes even after fallback: ${fallback}`)
}

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

export function defaultDaemonLogPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "daemon.log")
}

export function defaultClientLogPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "client.log")
}
