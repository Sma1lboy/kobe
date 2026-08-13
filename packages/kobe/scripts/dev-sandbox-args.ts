import { readRoveEnv, setRoveEnv } from "@sma1lboy/kobe-daemon/compat-env"

export type SandboxMode = "run" | "reset" | "home"
export type SandboxArgs = { mode: SandboxMode }

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
  const webPort = readRoveEnv("DAEMON_WEB_PORT", parent) ?? "5274"
  setRoveEnv("DEV", "1", env)
  setRoveEnv("HOME_DIR", home, env)
  setRoveEnv("DAEMON_WEB_PORT", webPort, env)
  return env
}
