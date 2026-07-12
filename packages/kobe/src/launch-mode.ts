export type LaunchMode = "puretui" | "tmux"

export type LaunchRequest =
  | { kind: "launch"; mode: LaunchMode }
  | { kind: "command"; args: readonly string[] }
  | { kind: "error"; message: string }

type LaunchFlag = "--puretui" | "--tmux"

function isLaunchFlag(value: string | undefined): value is LaunchFlag {
  return value === "--puretui" || value === "--tmux"
}

export function parseLaunchRequest(args: readonly string[]): LaunchRequest {
  if (args.length === 0) return { kind: "launch", mode: "puretui" }
  const first = args[0]
  if (!isLaunchFlag(first)) return { kind: "command", args }

  const other: LaunchFlag = first === "--tmux" ? "--puretui" : "--tmux"
  if (args.includes(other)) {
    return { kind: "error", message: "kobe: --tmux and --puretui cannot be used together" }
  }
  if (args.length > 1) {
    return { kind: "error", message: `kobe: launch flag "${first}" does not accept argument "${args[1]}"` }
  }
  return { kind: "launch", mode: first === "--tmux" ? "tmux" : "puretui" }
}
