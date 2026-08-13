import { deleteRoveEnv, readRoveEnv, setRoveEnv } from "@sma1lboy/kobe-daemon/compat-env"

export type SandboxMode = "run" | "reset" | "home"
export type SandboxArgs = { mode: SandboxMode }

/** The sandbox daemon's own web port — never production's 45174. */
export const SANDBOX_DAEMON_WEB_PORT = "5274"

/**
 * Ambient path overrides the sandbox must DROP rather than inherit.
 *
 * `defaultDaemonSocketPath()` / `defaultPtyHostSocketPath()` give an explicit
 * `*_SOCKET_PATH` override priority OVER `*_HOME_DIR`. The TUI stamps the
 * production socket onto its own env (`tui-react/workspace/host.tsx`), and
 * every task terminal it spawns inherits it — so a `dev:sandbox` launched from
 * inside a kobe task terminal used to bind the PRODUCTION socket while serving
 * its own empty task index. Attached TUIs then reconnected onto the sandbox
 * daemon and rendered "No active tasks" with every task still on disk
 * (prod 2026-08-13). Stamping HOME_DIR is not enough; the override has to go.
 */
const INHERITED_PATH_OVERRIDES = ["DAEMON_SOCKET_PATH", "DAEMON_PID_PATH", "PTY_SOCKET_PATH", "PTY_PID_PATH"] as const

function isSandboxMode(value: string | undefined): value is SandboxMode {
  return value === "run" || value === "reset" || value === "home"
}

export function parseSandboxArgs(args: readonly string[]): SandboxArgs {
  const first = args[0]
  if (first !== undefined && !isSandboxMode(first)) throw new Error(`unknown sandbox mode "${first}"`)
  if (args.length > 1) throw new Error(`unexpected argument "${args[1]}"`)
  return { mode: first ?? "run" }
}

/** Build a child environment whose sandbox invariants beat ambient aliases. */
export function sandboxChildEnv(home: string, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...parent }
  // Drop inherited production paths BEFORE stamping our own, so nothing an
  // ambient value could outrank survives into the child.
  for (const suffix of INHERITED_PATH_OVERRIDES) deleteRoveEnv(suffix, env)
  // The web port is sandbox-scoped too: read it from the SANDBOX_* namespace
  // (like SANDBOX_HOME_DIR) so a developer can still pick a port, while an
  // ambient production `DAEMON_WEB_PORT` — stamped by `kobe web` — cannot
  // drag the sandbox onto production's listener.
  const webPort = readRoveEnv("SANDBOX_DAEMON_WEB_PORT", parent) ?? SANDBOX_DAEMON_WEB_PORT
  setRoveEnv("DEV", "1", env)
  setRoveEnv("HOME_DIR", home, env)
  setRoveEnv("DAEMON_WEB_PORT", webPort, env)
  return env
}
