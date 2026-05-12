import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

export function defaultDaemonSocketPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR
  if (runtimeDir && runtimeDir.length > 0) return join(runtimeDir, "kobe.sock")
  return join(homeDir, ".kobe", "daemon.sock")
}

export function defaultDaemonPidPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "daemon.pid")
}

export function fallbackTestSocketPath(name: string): string {
  const dir = process.platform === "darwin" ? "/tmp" : tmpdir()
  return join(dir, `${name}-${process.pid}.sock`)
}
