import type { TuiDaemonMode } from "../daemon/mode.ts"

export interface ParsedCliArgs {
  readonly daemonMode?: TuiDaemonMode
  readonly args: readonly string[]
}

/**
 * Pull TUI daemon-mode flags out of top-level argv while leaving
 * subcommand args intact. The env var remains the script-facing escape
 * hatch; these flags are the human-facing spelling.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  let daemonMode: TuiDaemonMode | undefined
  const args: string[] = []

  for (const arg of argv) {
    if (arg === "--daemon") {
      if (daemonMode === "single") throw new Error("cannot pass both --daemon and --single")
      daemonMode = "shared"
      continue
    }
    if (arg === "--single") {
      if (daemonMode === "shared") throw new Error("cannot pass both --daemon and --single")
      daemonMode = "single"
      continue
    }
    args.push(arg)
  }

  return { daemonMode, args }
}

export type { TuiDaemonMode }
