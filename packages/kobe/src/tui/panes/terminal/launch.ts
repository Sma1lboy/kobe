import { execHostForRepo } from "@/exec/resolve"
import { shellQuote } from "@/tmux/session-layout"

export const REMOTE_KEY_OPTION = "@kobe_remote"

export function wrapEngineLaunch(engineCmd: string, remoteKey: string | undefined, remoteCwd: string): string {
  if (!remoteKey) return engineCmd
  const host = execHostForRepo(remoteKey)
  host.ensureReady()
  return host.wrapCommand(engineCmd, { tty: true, cwd: remoteCwd })
}

export function inheritedEnvPrefix(): string {
  const parts: string[] = []
  for (const key of ["KOBE_HOME_DIR", "KOBE_DAEMON_SOCKET_PATH", "KOBE_TMUX_SOCKET"]) {
    const value = process.env[key]
    if (value && value.length > 0) parts.push(`${key}=${shellQuote(value)}`)
  }
  return parts.length > 0 ? `${parts.join(" ")} ` : ""
}
