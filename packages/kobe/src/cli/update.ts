/**
 * `kobe update` — self-update helper for the globally-installed CLI.
 *
 * The TUI update chip points at a GitHub-hosted update script. This
 * wrapper intentionally delegates to that remote script instead of
 * baking the package-manager command into the binary, so future install
 * flow changes only require editing `scripts/update.sh` on main.
 *
 * `kobe update <version>` pins the install (the script receives the
 * version as `sh -s -- <version>`); `kobe update list` prints recent
 * published versions. Verbs are the canonical spelling — `--list` /
 * `--dry-run` stay as accepted aliases. Installing across a
 * {@link BREAKING_VERSIONS} entry prints a
 * heads-up that the next launch will demand `kobe reset` (the boot gate
 * in reset-gate.ts is the enforcement point — the script stays dumb).
 */

import { spawnSync } from "node:child_process"
import {
  BREAKING_VERSIONS,
  CURRENT_VERSION,
  UPDATE_COMMAND,
  UPDATE_SCRIPT_URL,
  breakingVersionsCrossed,
  checkLatestVersion,
  fetchReleaseSummaries,
  recommendedGlobalInstallCommand,
} from "../version.ts"

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

export function updatePlan(version?: string): UpdatePlan {
  const shell = version === undefined ? UPDATE_COMMAND : `${UPDATE_COMMAND} -s -- ${version}`
  return {
    command: "sh",
    args: ["-c", shell],
    display: shell,
  }
}

type ParsedArgs = {
  help: boolean
  dryRun: boolean
  list: boolean
  /** Pinned target version (`kobe update 0.7.90`); undefined = latest. */
  version?: string
}

const VERSION_SHAPE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

export function parseUpdateArgs(args: readonly string[]): ParsedArgs {
  let dryRun = false
  let list = false
  let version: string | undefined

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === undefined) continue
    if (arg === "--help" || arg === "-h" || arg === "help") return { help: true, dryRun, list, version }
    if (arg === "dry-run" || arg === "--dry-run") {
      dryRun = true
      continue
    }
    if (arg === "list" || arg === "--list") {
      list = true
      continue
    }
    if (version === undefined && VERSION_SHAPE.test(arg)) {
      version = arg
      continue
    }
    // Malformed invocation → show the error AND the usage, exit 2. An
    // agent that guesses a flag wrong should land on the instruction
    // surface, not a bare one-liner.
    process.stderr.write(`kobe update: unknown argument "${arg}"\n\n`)
    printUsage(process.stderr)
    process.exit(2)
  }

  return { help: false, dryRun, list, version }
}

function printUsage(out: Pick<typeof process.stderr, "write">): void {
  out.write(
    [
      "Usage: kobe update [version|list|dry-run]",
      "",
      "Runs kobe's GitHub-hosted update script. With [version] (e.g.",
      "0.7.90) the script installs that exact release instead of latest.",
      "",
      "Verbs (--flag spellings also accepted):",
      "  list      Browse recent versions — a TUI page with release notes",
      "            when interactive, plain text when piped",
      "  dry-run   Print the command without running it",
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
      "  kobe update 0.7.90",
      "  kobe update list",
      "  kobe update dry-run",
      "",
    ].join("\n"),
  )
}

/** `--list`: recent GitHub releases, newest first, current marked. */
async function printVersionList(io: RunDeps): Promise<void> {
  const releases = await fetchReleaseSummaries(20)
  if (releases.length === 0) {
    io.stderr.write("kobe update: could not fetch the release list (offline or rate-limited)\n")
    io.exit(1)
  }
  for (const release of releases) {
    const markers = [
      release.version === CURRENT_VERSION ? "(current)" : "",
      BREAKING_VERSIONS.includes(release.version) ? "(breaking — needs `kobe reset`)" : "",
    ]
      .filter(Boolean)
      .join(" ")
    io.stdout.write(`${release.version}${markers ? `  ${markers}` : ""}\n`)
  }
  io.stdout.write("\ninstall one with: kobe update <version>\n")
}

/**
 * Best-effort heads-up when the move crosses a breaking version. Pinned
 * targets need no network; "latest" resolves via the registry and stays
 * silent when offline — the boot gate is the real enforcement point.
 */
async function warnBreakingCrossings(target: string | undefined, io: RunDeps): Promise<void> {
  // Nothing registered → nothing to warn about; skip the "latest" lookup
  // entirely so the common path (and the test suite) never touches the net.
  if (BREAKING_VERSIONS.length === 0) return
  const resolved = target ?? (await checkLatestVersion({ force: true }))?.latest
  if (!resolved) return
  const crossed = breakingVersionsCrossed(CURRENT_VERSION, resolved)
  if (crossed.length === 0) return
  io.stderr.write(
    [
      `warning: ${CURRENT_VERSION} -> ${resolved} crosses breaking version(s): ${crossed.join(", ")}.`,
      "After this update, kobe will refuse to start until you run `kobe reset`",
      "(worktrees are never touched; add --hard only to also wipe the task index).",
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
  if (parsed.list) {
    // Interactive terminal → the TUI versions browser (list + release
    // notes + pinned install). Injected deps (tests) or a pipe keep the
    // plain parseable text output for scripts and agents.
    if (deps === undefined && process.stdout.isTTY) {
      const { startVersionsHost } = await import("../tui-react/component/versions-page.tsx")
      await startVersionsHost()
      return
    }
    await printVersionList(io)
    return
  }

  const plan = updatePlan(parsed.version)
  io.stdout.write(`kobe ${CURRENT_VERSION} -> ${parsed.version ?? "latest"}\n`)
  io.stdout.write(`running: ${plan.display}\n`)
  if (parsed.dryRun) return
  await warnBreakingCrossings(parsed.version, io)

  const result = io.spawn(plan.command, plan.args, { stdio: "inherit" })
  if (result.error) {
    io.stderr.write(`kobe update: failed to run ${plan.command}: ${result.error.message}\n`)
    io.exit(1)
  }
  io.exit(result.status ?? 1)
}
