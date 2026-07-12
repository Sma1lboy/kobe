import { parseLaunchRequest } from "../src/launch-mode.ts"

export type SandboxMode = "run" | "reset" | "home"
export type SandboxArgs = { mode: SandboxMode; launchFlag?: "--puretui" | "--tmux" }

function isSandboxMode(value: string | undefined): value is SandboxMode {
  return value === "run" || value === "reset" || value === "home"
}

function isLaunchFlag(value: string): value is "--puretui" | "--tmux" {
  return value === "--puretui" || value === "--tmux"
}

export function parseSandboxArgs(args: readonly string[]): SandboxArgs {
  const first = args[0]
  const mode: SandboxMode = first === undefined || first.startsWith("--") ? "run" : isSandboxMode(first) ? first : "run"
  const launchArgs = first === undefined ? [] : isSandboxMode(first) ? args.slice(1) : args

  if (first !== undefined && !isSandboxMode(first) && !first.startsWith("--")) {
    throw new Error(`unknown sandbox mode "${first}"`)
  }
  if (mode !== "run") {
    if (launchArgs.some(isLaunchFlag)) throw new Error("launch flags are valid only for run")
    if (launchArgs.length > 0) throw new Error(`unexpected argument "${launchArgs[0]}"`)
    return { mode }
  }

  const request = parseLaunchRequest(launchArgs)
  if (request.kind === "error") throw new Error(request.message)
  if (request.kind === "command") throw new Error(`unexpected argument "${request.args[0]}"`)
  return launchArgs.length === 0 ? { mode } : { mode, launchFlag: launchArgs[0] as "--puretui" | "--tmux" }
}
