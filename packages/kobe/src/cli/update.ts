/**
 * `kobe update` — self-update helper for the globally-installed CLI.
 *
 * The TUI update chip points at a GitHub-hosted update script. This
 * wrapper intentionally delegates to that remote script instead of
 * baking the package-manager command into the binary, so future install
 * flow changes only require editing `scripts/update.sh` on main.
 */

import { spawnSync } from "node:child_process"
import { CURRENT_VERSION, UPDATE_COMMAND, UPDATE_SCRIPT_URL, recommendedGlobalInstallCommand } from "../version.ts"

export type UpdatePlan = {
  command: string
  args: string[]
  display: string
}

type RunDeps = {
  spawn: typeof spawnSync
  stdout: Pick<typeof process.stdout, "write">
  stderr: Pick<typeof process.stderr, "write">
  exit: (code: number) => never
}

export function updatePlan(): UpdatePlan {
  return {
    command: "sh",
    args: ["-c", UPDATE_COMMAND],
    display: UPDATE_COMMAND,
  }
}

type ParsedArgs = {
  help: boolean
  dryRun: boolean
}

export function parseUpdateArgs(args: readonly string[]): ParsedArgs {
  let dryRun = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === "--help" || arg === "-h" || arg === "help") return { help: true, dryRun }
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }
    // Malformed invocation → show the error AND the usage, exit 2. An
    // agent that guesses a flag wrong should land on the instruction
    // surface, not a bare one-liner.
    process.stderr.write(`kobe update: unknown argument "${arg}"\n\n`)
    printUsage(process.stderr)
    process.exit(2)
  }

  return { help: false, dryRun }
}

function printUsage(out: Pick<typeof process.stderr, "write">): void {
  out.write(
    [
      "Usage: kobe update [--dry-run]",
      "",
      "Runs kobe's GitHub-hosted update script.",
      "",
      "Default command:",
      `  ${UPDATE_COMMAND}`,
      "",
      "Script URL:",
      `  ${UPDATE_SCRIPT_URL}`,
      "",
      "Manual fallback:",
      `  ${recommendedGlobalInstallCommand()}`,
      "",
      "Examples:",
      "  kobe update",
      "  kobe update --dry-run",
      "",
    ].join("\n"),
  )
}

export async function runUpdateSubcommand(args: readonly string[], deps?: Partial<RunDeps>): Promise<void> {
  const io: RunDeps = {
    spawn: deps?.spawn ?? spawnSync,
    stdout: deps?.stdout ?? process.stdout,
    stderr: deps?.stderr ?? process.stderr,
    exit: deps?.exit ?? ((code) => process.exit(code)),
  }
  const parsed = parseUpdateArgs(args)
  if (parsed.help) {
    printUsage(io.stdout)
    return
  }

  const plan = updatePlan()
  io.stdout.write(`kobe ${CURRENT_VERSION} -> latest\n`)
  io.stdout.write(`running: ${plan.display}\n`)
  if (parsed.dryRun) return

  const result = io.spawn(plan.command, plan.args, { stdio: "inherit" })
  if (result.error) {
    io.stderr.write(`kobe update: failed to run ${plan.command}: ${result.error.message}\n`)
    io.exit(1)
  }
  io.exit(result.status ?? 1)
}
